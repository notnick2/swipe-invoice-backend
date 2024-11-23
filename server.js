require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid'); // For unique folder names
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleAIFileManager } = require('@google/generative-ai/server');

const app = express();
const PORT = process.env.PORT || 5000;

// Setup Google Generative AI
const apiKey = process.env.GEMINI_API_KEY;
console.log(apiKey);
const genAI = new GoogleGenerativeAI(apiKey);
const fileManager = new GoogleAIFileManager(apiKey);

// Multer storage setup to handle file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const requestId = req.requestId; // Attach request ID to the folder
    const folderPath = path.join(__dirname, 'uploads', requestId);
    fs.mkdirSync(folderPath, { recursive: true }); // Create folder (if not exists)
    cb(null, folderPath);
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname); // Keep original filename
  },
});
const upload = multer({ storage });

// Middleware to generate unique folder/request ID
app.use((req, res, next) => {
  req.requestId = uuidv4(); // Generate a unique ID for the request
  next();
});

// Enable CORS
const cors = require('cors');
app.use(cors());
app.use(express.json());

// Upload route
app.post('/upload', upload.array('files'), async (req, res) => {
  try {
    const requestId = req.requestId; // Unique folder for this request
    const folderPath = path.join(__dirname, 'uploads', requestId);
    const files = req.files;

    if (!files || files.length === 0) {
      return res.status(400).json({ message: 'No files uploaded!' });
    }

    console.log(`Files for request ${requestId} are stored at: ${folderPath}`);

    // Process files with Gemini
    const uploadedFiles = [];
    for (const file of files) {
      const fileMimeType = file.mimetype;
      const filePath = file.path;

      console.log(`Uploading file: ${file.originalname}`);
      const uploadResult = await uploadToGemini(filePath, fileMimeType);
      uploadedFiles.push(uploadResult);
    }

    // Wait for all files to become ACTIVE
    await waitForFilesActive(uploadedFiles);

    // Send request to Gemini model
    const geminiResponse = await getGeminiResponse(uploadedFiles);

    // Send response back to frontend
    res.status(200).json({ message: 'Files processed successfully!', geminiResponse });

    // Cleanup: Delete folder after processing
    fs.rmSync(folderPath, { recursive: true, force: true });
    console.log(`Deleted folder: ${folderPath}`);
  } catch (error) {
    console.error('Error processing files:', error);
    res.status(500).json({ message: 'Error processing files', error: error.message });
  }
});

// Function to upload a file to Gemini
async function uploadToGemini(filePath, mimeType) {
  const uploadResult = await fileManager.uploadFile(filePath, {
    mimeType,
    displayName: path.basename(filePath),
  });
  console.log(`Uploaded file ${path.basename(filePath)} as: ${uploadResult.file.name}`);
  return uploadResult.file;
}

// Function to wait until files are active
async function waitForFilesActive(files) {
  console.log('Waiting for file processing...');
  for (const name of files.map((file) => file.name)) {
    let file = await fileManager.getFile(name);
    while (file.state === 'PROCESSING') {
      process.stdout.write('.');
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      file = await fileManager.getFile(name);
    }
    if (file.state !== 'ACTIVE') {
      throw new Error(`File ${file.name} failed to process`);
    }
  }
  console.log('...all files are ready\n');
}

// Function to get response from Gemini
async function getGeminiResponse(files) {
  const model = genAI.getGenerativeModel({
    model: 'gemini-1.5-flash',
    systemInstruction: 'give response in the expected json format',
  });

  const fileInputs = files.map((file) => ({
    fileData: {
      mimeType: file.mimeType,
      fileUri: file.uri,
    },
  }));

  const chatSession = model.startChat({
    generationConfig: {
      temperature: 1,
      topP: 0.95,
      topK: 40,
      maxOutputTokens: 8192,
      responseMimeType: 'application/json',
    },
    history: [
      {
        role: 'user',
        parts: fileInputs,
      },
    ],
  });

  const result = await chatSession.sendMessage('Give the response in the expected format. invoices with following fields serialNumber, customerName, productName, quantity, tax, totalAmount, date all these fields in the response are mandatory if there is no data for a field put null. products with following fields name, quantity, unitPrice, tax, priceWithTax, discount all these fields are mandatory if there is no data for a field put null. customers with customerName, phoneNumber, totalPurchaseAmount all fields are mandatory if there is no data for a field put null. It is MANDATORY that you give for all three the invoices, products and the cutomers for every response');
  console.log('Gemini Response:', result.response.text());
  return result.response.text();
}

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
