require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleAIFileManager } = require('@google/generative-ai/server');
const XLSX = require('xlsx');
const csv = require('csv-parser');

const app = express();
const PORT = process.env.PORT || 5000;

// Setup Google Generative AI
const apiKey = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(apiKey);
const fileManager = new GoogleAIFileManager(apiKey);

// Multer storage setup to handle file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const requestId = req.requestId;
    const folderPath = path.join(__dirname, 'uploads', requestId);
    fs.mkdirSync(folderPath, { recursive: true });
    cb(null, folderPath);
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  },
});
const upload = multer({ storage });

// Middleware to generate unique folder/request ID
app.use((req, res, next) => {
  req.requestId = uuidv4();
  next();
});

// Enable CORS
const cors = require('cors');
app.use(cors());
app.use(express.json());

// Function to convert Excel to CSV
async function convertExcelToCSV(excelPath, folderPath) {
  const workbook = XLSX.readFile(excelPath);
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  
  // Convert to CSV
  const csvContent = XLSX.utils.sheet_to_csv(worksheet);
  
  // Create CSV file path
  const csvFilename = path.basename(excelPath, path.extname(excelPath)) + '.csv';
  const csvPath = path.join(folderPath, csvFilename);
  
  // Write CSV file
  fs.writeFileSync(csvPath, csvContent);
  
  console.log(`Converted ${path.basename(excelPath)} to CSV: ${csvFilename}`);
  return csvPath;
}

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

  const result = await chatSession.sendMessage('Give the response in the expected format. invoices with following fields serialNumber, customerName, productName, quantity, tax, totalAmount, date all these fields in the response are mandatory if there is no data for a field put null. products with following fields name, quantity, unitPrice, tax, priceWithTax, discount all these fields are mandatory if there is no data for a field put null. customers with customerName, phoneNumber, totalPurchaseAmount all fields are mandatory if there is no data for a field put null. It is MANDATORY that you give for all three the invoices, products and the cutomers for every response. make sure to give a complete json each time if the json is too big make sure you finish before you reach limit of response length only when the response is too large make sure to combine data from different files if data can be mapped from multiple files');
  console.log('Gemini Response:', result.response.text());
  return result.response.text();
}

// Upload route
app.post('/upload', upload.array('files'), async (req, res) => {
  try {
    const requestId = req.requestId;
    const folderPath = path.join(__dirname, 'uploads', requestId);
    const files = req.files;

    if (!files || files.length === 0) {
      return res.status(400).json({ message: 'No files uploaded!' });
    }

    console.log(`Files for request ${requestId} are stored at: ${folderPath}`);

    // Process files with Gemini
    const uploadedFiles = [];
    for (const file of files) {
      let filePath = file.path;
      let fileMimeType = file.mimetype;

      // Check if file is Excel/XLSX
      if (fileMimeType.includes('spreadsheet') || 
          filePath.endsWith('.xlsx') || 
          filePath.endsWith('.xls')) {
        
        // Convert to CSV
        const csvPath = await convertExcelToCSV(filePath, folderPath);
        filePath = csvPath;
        fileMimeType = 'text/csv';
        
        // Delete the original Excel file
        fs.unlinkSync(file.path);
      }

      console.log(`Uploading file: ${path.basename(filePath)}`);
      const uploadResult = await uploadToGemini(filePath, fileMimeType);
      uploadedFiles.push(uploadResult);
    }

    await waitForFilesActive(uploadedFiles);
    const geminiResponse = await getGeminiResponse(uploadedFiles);
    res.status(200).json({ message: 'Files processed successfully!', geminiResponse });

    // Cleanup: Delete folder after processing
    fs.rmSync(folderPath, { recursive: true, force: true });
    console.log(`Deleted folder: ${folderPath}`);
  } catch (error) {
    console.error('Error processing files:', error);
    res.status(500).json({ message: 'Error processing files', error: error.message });
  }
});

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
  console.log('Created uploads directory');
}

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});