// Express.js File Processing Server for Render
const express = require('express');
const cors = require('cors');
const sharp = require('sharp');
const { PDFDocument } = require('pdf-lib');
const JSZip = require('jszip');

const app = express();
const PORT = process.env.PORT || 3000;

// Render's free tier has 512MB RAM limit
const MAX_REQUEST_SIZE = 100 * 1024 * 1024; // 100MB request size limit
const MAX_MEMORY_USAGE = 400 * 1024 * 1024; // 400MB memory usage limit

// Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Request timeout middleware
app.use((req, res, next) => {
    req.setTimeout(25000); // 25 seconds timeout (Render's limit is 30s)
    res.setTimeout(25000);
    next();
});

// Health check endpoint
app.get('/', (req, res) => {
    res.json({
        status: 'OK',
        message: 'File Processing Server is running on Render',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        environment: 'Render Free Tier'
    });
});

app.get('/health', (req, res) => {
    const memoryUsage = process.memoryUsage();
    res.json({
        status: 'OK',
        message: 'File processing server is running',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        memory: {
            used: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)} MB`,
            total: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)} MB`,
            percentage: `${Math.round((memoryUsage.heapUsed / memoryUsage.heapTotal) * 100)}%`
        }
    });
});

// Main file processing endpoint
app.post('/process-files', async (req, res) => {
    try {
        const { files, outputFormat, compression, imageFormat } = req.body;

        if (!files || files.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'No files provided'
            });
        }

        // Check total size
        const totalSize = files.reduce((sum, file) => sum + (file.size || 0), 0);
        if (totalSize > MAX_REQUEST_SIZE) {
            return res.status(413).json({
                success: false,
                error: `Total file size exceeds ${MAX_REQUEST_SIZE / 1024 / 1024}MB limit`
            });
        }

        console.log(`Processing ${files.length} files, total size: ${(totalSize / 1024 / 1024).toFixed(2)}MB`);

        // Process files based on format
        let result;
        switch (outputFormat) {
            case 'pdf':
                result = await processToPDF(files);
                break;
            case 'docx':
                result = await processToDocx(files);
                break;
            case 'collage':
                result = await processToCollage(files, imageFormat || 'jpeg');
                break;
            case 'zip':
                result = await processToZip(files);
                break;
            case 'image':
                result = await processImages(files, imageFormat || 'jpeg');
                break;
            default:
                throw new Error('Unsupported output format');
        }

        // Apply compression if requested
        if (compression && compression.enabled) {
            result = await compressFile(result, compression);
        }

        // Check memory usage before sending response
        const memoryUsage = process.memoryUsage();
        if (memoryUsage.heapUsed > MAX_MEMORY_USAGE) {
            console.warn(`High memory usage: ${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB`);
            // Force garbage collection if available
            if (global.gc) {
                global.gc();
            }
        }

        // Return file directly as base64
        const base64Data = result.buffer.toString('base64');

        res.json({
            success: true,
            message: 'Files processed successfully',
            file: {
                data: base64Data,
                filename: result.filename,
                contentType: result.contentType,
                size: result.buffer.length
            },
            originalSize: totalSize,
            compressionRatio: totalSize > 0 ? (result.buffer.length / totalSize).toFixed(2) : '1.00',
            processingTime: Date.now() - (req.startTime || Date.now())
        });

    } catch (error) {
        console.error('Processing error:', error);
        res.status(400).json({
            success: false,
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Convert files to PDF
async function processToPDF(files) {
    const pdfDoc = await PDFDocument.create();
    
    for (const file of files) {
        try {
            const fileBuffer = Buffer.from(file.data, 'base64');
            
            if (file.type === 'application/pdf') {
                // Merge existing PDF
                const existingPdf = await PDFDocument.load(fileBuffer);
                const pages = await pdfDoc.copyPages(existingPdf, existingPdf.getPageIndices());
                pages.forEach((page) => pdfDoc.addPage(page));
            } else if (file.type.startsWith('image/')) {
                // Convert image to PDF page
                const image = await sharp(fileBuffer)
                    .resize(595, 842, { fit: 'inside' }) // A4 size
                    .png()
                    .toBuffer();
                
                const pdfImage = await pdfDoc.embedPng(image);
                const page = pdfDoc.addPage([595, 842]);
                
                const { width, height } = pdfImage.scale(1);
                const scale = Math.min(595 / width, 842 / height);
                
                page.drawImage(pdfImage, {
                    x: (595 - width * scale) / 2,
                    y: (842 - height * scale) / 2,
                    width: width * scale,
                    height: height * scale
                });
            }
        } catch (error) {
            console.warn(`Failed to process ${file.name}:`, error.message);
        }
    }

    const pdfBytes = await pdfDoc.save();
    const filename = `processed-${Date.now()}.pdf`;

    return {
        buffer: Buffer.from(pdfBytes),
        filename,
        contentType: 'application/pdf'
    };
}

// Process DOCX files (simplified - just merge text)
async function processToDocx(files) {
    let combinedText = '';
    
    for (const file of files) {
        combinedText += `\n\n--- Content from ${file.name} ---\n`;
        combinedText += `File type: ${file.type}\n`;
        combinedText += `File processed: ${new Date().toISOString()}\n`;
        combinedText += `Original size: ${(file.size / 1024).toFixed(2)} KB\n`;
        
        if (file.type.includes('text') || file.type.includes('plain')) {
            try {
                const textContent = Buffer.from(file.data, 'base64').toString('utf-8');
                combinedText += `\nContent:\n${textContent}\n`;
            } catch (error) {
                combinedText += `\n[Error reading text content: ${error.message}]\n`;
            }
        }
        
        combinedText += '\n' + '='.repeat(50) + '\n';
    }

    const filename = `merged-documents-${Date.now()}.txt`;
    
    return {
        buffer: Buffer.from(combinedText, 'utf-8'),
        filename,
        contentType: 'text/plain'
    };
}

// Create image collage
async function processToCollage(files, outputFormat = 'jpeg') {
    const imageFiles = files.filter(f => f.type.startsWith('image/'));
    
    if (imageFiles.length === 0) {
        throw new Error('No image files found for collage');
    }

    // Process images with memory management
    const processedImages = [];
    for (const file of imageFiles) {
        try {
            const buffer = Buffer.from(file.data, 'base64');
            const processed = await sharp(buffer)
                .resize(400, 400, { fit: 'cover' })
                .toBuffer();
            processedImages.push(processed);
        } catch (error) {
            console.warn(`Failed to process image ${file.name}:`, error.message);
        }
    }

    if (processedImages.length === 0) {
        throw new Error('No valid images could be processed for collage');
    }

    // Calculate grid dimensions
    const count = processedImages.length;
    const cols = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / cols);
    
    const cellWidth = 400;
    const cellHeight = 400;
    const canvasWidth = cols * cellWidth;
    const canvasHeight = rows * cellHeight;

    // Create collage
    const canvas = sharp({
        create: {
            width: canvasWidth,
            height: canvasHeight,
            channels: 3,
            background: { r: 255, g: 255, b: 255 }
        }
    });

    const composite = processedImages.map((image, index) => {
        const row = Math.floor(index / cols);
        const col = index % cols;
        
        return {
            input: image,
            left: col * cellWidth,
            top: row * cellHeight
        };
    });

    // Apply format-specific processing
    let collageBuffer;
    let contentType;
    let extension;

    const sharpInstance = canvas.composite(composite);

    switch (outputFormat.toLowerCase()) {
        case 'jpeg':
        case 'jpg':
            collageBuffer = await sharpInstance.jpeg({ quality: 85 }).toBuffer();
            contentType = 'image/jpeg';
            extension = 'jpg';
            break;
        case 'png':
            collageBuffer = await sharpInstance.png({ quality: 85 }).toBuffer();
            contentType = 'image/png';
            extension = 'png';
            break;
        case 'webp':
            collageBuffer = await sharpInstance.webp({ quality: 85 }).toBuffer();
            contentType = 'image/webp';
            extension = 'webp';
            break;
        default:
            collageBuffer = await sharpInstance.jpeg({ quality: 85 }).toBuffer();
            contentType = 'image/jpeg';
            extension = 'jpg';
    }

    const filename = `collage-${Date.now()}.${extension}`;

    return {
        buffer: collageBuffer,
        filename,
        contentType
    };
}

// Process individual images
async function processImages(files, outputFormat = 'jpeg') {
    const imageFiles = files.filter(f => f.type.startsWith('image/'));
    
    if (imageFiles.length === 0) {
        throw new Error('No image files found');
    }

    // Single image
    if (imageFiles.length === 1) {
        const file = imageFiles[0];
        const buffer = Buffer.from(file.data, 'base64');
        return await convertSingleImage(buffer, file.name, outputFormat);
    }

    // Multiple images - create ZIP
    const zip = new JSZip();
    
    for (const file of imageFiles) {
        try {
            const buffer = Buffer.from(file.data, 'base64');
            const convertedImage = await convertSingleImage(buffer, file.name, outputFormat);
            zip.file(convertedImage.filename, convertedImage.buffer);
        } catch (error) {
            console.warn(`Failed to convert ${file.name}:`, error.message);
        }
    }

    const zipBuffer = await zip.generateAsync({ 
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 }
    });

    return {
        buffer: zipBuffer,
        filename: `converted-images-${Date.now()}.zip`,
        contentType: 'application/zip'
    };
}

// Convert single image
async function convertSingleImage(buffer, originalName, outputFormat) {
    const sharpInstance = sharp(buffer).rotate(); // Auto-orient
    
    let convertedBuffer;
    let contentType;
    let extension;
    
    switch (outputFormat.toLowerCase()) {
        case 'jpeg':
        case 'jpg':
            convertedBuffer = await sharpInstance.jpeg({ quality: 85, progressive: true }).toBuffer();
            contentType = 'image/jpeg';
            extension = 'jpg';
            break;
        case 'png':
            convertedBuffer = await sharpInstance.png({ quality: 85 }).toBuffer();
            contentType = 'image/png';
            extension = 'png';
            break;
        case 'webp':
            convertedBuffer = await sharpInstance.webp({ quality: 85 }).toBuffer();
            contentType = 'image/webp';
            extension = 'webp';
            break;
        default:
            convertedBuffer = await sharpInstance.jpeg({ quality: 85, progressive: true }).toBuffer();
            contentType = 'image/jpeg';
            extension = 'jpg';
    }

    const nameWithoutExt = originalName.replace(/\.[^.]+$/, '');
    const filename = `${nameWithoutExt}-converted.${extension}`;

    return {
        buffer: convertedBuffer,
        filename,
        contentType
    };
}

// Create ZIP archive
async function processToZip(files) {
    const zip = new JSZip();
    
    for (const file of files) {
        try {
            const buffer = Buffer.from(file.data, 'base64');
            zip.file(file.name, buffer);
        } catch (error) {
            console.warn(`Failed to add ${file.name} to ZIP:`, error.message);
        }
    }

    const zipBuffer = await zip.generateAsync({ 
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 }
    });

    const filename = `archive-${Date.now()}.zip`;

    return {
        buffer: zipBuffer,
        filename,
        contentType: 'application/zip'
    };
}

// Compress file
async function compressFile(fileResult, compression) {
    try {
        const targetSizeBytes = compression.unit === 'MB' ? 
            parseFloat(compression.size) * 1024 * 1024 : 
            parseFloat(compression.size) * 1024;

        if (fileResult.buffer.length <= targetSizeBytes) {
            return fileResult;
        }

        // Image compression
        if (fileResult.contentType.startsWith('image/')) {
            let quality = 85;
            let compressedBuffer = fileResult.buffer;
            const originalFormat = fileResult.contentType;

            while (compressedBuffer.length > targetSizeBytes && quality > 10) {
                quality -= 10;
                
                const sharpInstance = sharp(fileResult.buffer);
                
                if (originalFormat.includes('jpeg')) {
                    compressedBuffer = await sharpInstance.jpeg({ quality, progressive: true }).toBuffer();
                } else if (originalFormat.includes('png')) {
                    compressedBuffer = await sharpInstance.png({ quality, compressionLevel: 9 }).toBuffer();
                } else if (originalFormat.includes('webp')) {
                    compressedBuffer = await sharpInstance.webp({ quality }).toBuffer();
                } else {
                    compressedBuffer = await sharpInstance.webp({ quality }).toBuffer();
                    fileResult.contentType = 'image/webp';
                    fileResult.filename = fileResult.filename.replace(/\.[^.]+$/, '.webp');
                }
            }

            return { ...fileResult, buffer: compressedBuffer };
        }

        // ZIP compression
        if (fileResult.contentType === 'application/zip') {
            const zip = new JSZip();
            await zip.loadAsync(fileResult.buffer);
            
            const compressedBuffer = await zip.generateAsync({
                type: 'nodebuffer',
                compression: 'DEFLATE',
                compressionOptions: { level: 9 }
            });

            return { ...fileResult, buffer: compressedBuffer };
        }

        return fileResult;

    } catch (error) {
        console.warn('Compression failed:', error.message);
        return fileResult;
    }
}

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Server error:', error);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        timestamp: new Date().toISOString()
    });
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint not found',
        timestamp: new Date().toISOString()
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 File Processing Server running on port ${PORT}`);
    console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`💾 Memory limit: ${MAX_MEMORY_USAGE / 1024 / 1024}MB`);
    console.log(`📁 Max request size: ${MAX_REQUEST_SIZE / 1024 / 1024}MB`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down gracefully');
    process.exit(0);
});

// Error handlers
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    process.exit(1);
});
