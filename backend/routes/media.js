const express = require('express');
const router = express.Router();
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const authenticate = require('../middleware/authenticate');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Use memory storage so we can pipe to Cloudinary
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB max
  fileFilter(req, file, cb) {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp',
                     'video/mp4', 'video/quicktime', 'video/webm',
                     'audio/webm', 'audio/ogg', 'audio/mpeg'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('File type not allowed'));
  },
});

// Helper: upload buffer to cloudinary
function uploadToCloudinary(buffer, options) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
    stream.end(buffer);
  });
}

// ─── UPLOAD media (photo / video / voice note) ─────────────
router.post('/upload', authenticate, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const isVideo = req.file.mimetype.startsWith('video/');
  const isAudio = req.file.mimetype.startsWith('audio/');

  try {
    const resourceType = isVideo ? 'video' : isAudio ? 'video' : 'image';
    const folder = `zapchat/${req.user.id}`;

    const result = await uploadToCloudinary(req.file.buffer, {
      resource_type: resourceType,
      folder,
      // Generate thumbnail for videos automatically
      eager: isVideo ? [{ width: 400, height: 400, crop: 'fill', format: 'jpg' }] : [],
      eager_async: false,
    });

    res.json({
      url: result.secure_url,
      type: isAudio ? 'audio' : isVideo ? 'video' : 'image',
      thumbnail_url: isVideo && result.eager?.[0]?.secure_url || null,
      duration: result.duration || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// ─── UPLOAD avatar ─────────────────────────────────────────
router.post('/avatar', authenticate, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const result = await uploadToCloudinary(req.file.buffer, {
      resource_type: 'image',
      folder: `zapchat/avatars`,
      public_id: `user_${req.user.id}`,
      overwrite: true,
      transformation: [{ width: 400, height: 400, crop: 'fill', gravity: 'face', format: 'jpg' }],
    });

    res.json({ url: result.secure_url });
  } catch (err) {
    res.status(500).json({ error: 'Avatar upload failed' });
  }
});

module.exports = router;
