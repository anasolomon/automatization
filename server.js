const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Configurazione -------------------------------------------------
// Su Windows, se ffmpeg non è nel PATH di sistema, metti qui il percorso completo:
// es. 'C:\\ffmpeg\\bin\\ffmpeg.exe'
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
// Su Windows, se "magick" non è nel PATH, metti qui il percorso completo,
// es. 'C:\\Program Files\\ImageMagick-7.1.2-Q16-HDRI\\magick.exe'
const IMAGEMAGICK_PATH = process.env.IMAGEMAGICK_PATH || 'magick';

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'output');

// Crea le cartelle se non esistono
[UPLOAD_DIR, OUTPUT_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// --- Upload multipart (multer) ---------------------------------------
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 200 * 1024 * 1024 } // 200 MB, alza/abbassa a piacere
});
const uploadImage = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      // Preservo l'estensione originale (.jpg/.png/...), invece di lasciare
      // che multer dia un nome casuale SENZA estensione
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `img_${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 30 * 1024 * 1024 } // 30 MB, un'immagine non ha bisogno di più
});


app.use(express.static(path.join(__dirname, 'public')));

// --- L'endpoint vero e proprio ----------------------------------------
app.post('/avi_converter', upload.single('video'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nessun file video caricato.' });
  }

  // Parametri opzionali dal form (con gli stessi default del tool PHP del tutor)
  const quality = parseInt(req.body.quality, 10) || 5;
  const frameRate = parseInt(req.body.frame_rate, 10) || 15;
  const rotation = parseInt(req.body.rotation, 10) || 0; // 0=nessuna, 1=destra, 2=sinistra
  const width = parseInt(req.body.width, 10) || 1370;
  const height = parseInt(req.body.height, 10) || 768;

  const inputPath = req.file.path;
  const outputFileName = `converted_${Date.now()}.avi`;
  const outputPath = path.join(OUTPUT_DIR, outputFileName);

  // Costruzione degli argomenti — stessa identica struttura del comando CLI
  // ffmpeg -y -i input -c:v mjpeg -q:v 5 -r 15 -an -vf "transpose=2" -s 1370x768 output
  const args = [
    '-y',
    '-i', inputPath,
    '-c:v', 'mjpeg',
    '-q:v', String(quality),
    '-r', String(frameRate),
    '-an'
  ];

  if (rotation !== 0) {
    args.push('-vf', `transpose=${rotation}`);
  }

  args.push('-s', `${width}x${height}`, outputPath);

  console.log('Comando ffmpeg:', FFMPEG_PATH, args.join(' '));

  const ffmpegProcess = spawn(FFMPEG_PATH, args);

  let stderrLog = '';
  ffmpegProcess.stderr.on('data', (data) => {
    stderrLog += data.toString();
  });

  ffmpegProcess.on('error', (err) => {
    // Scatta tipicamente se ffmpeg non è trovato/nel PATH
    console.error('Errore avvio ffmpeg:', err);
    cleanupUpload(inputPath);
    res.status(500).json({
      error: 'Impossibile avviare ffmpeg. Controlla il percorso (FFMPEG_PATH).',
      details: err.message
    });
  });

  ffmpegProcess.on('close', (code) => {
    cleanupUpload(inputPath);

    if (code !== 0) {
      console.error('ffmpeg terminato con errore, log:', stderrLog);
      return res.status(500).json({
        error: 'Conversione fallita.',
        ffmpegLog: stderrLog
      });
    }

    // Successo: invia il file convertito come download
    res.download(outputPath, 'video_convertito.avi', (err) => {
      // Pulizia del file di output dopo l'invio, come faceva download.php
      fs.unlink(outputPath, () => {});
      if (err) console.error('Errore invio file:', err);
    });
  });
});

function cleanupUpload(filePath) {
  fs.unlink(filePath, () => {});
}

// --- Convertitore immagini (ImageMagick) --------------------------------
//   magick input -rotate -90 -resize 1366x768^ -gravity center -extent 1366x768 output.jpg
app.post('/jpg_converter', uploadImage.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nessuna immagine caricata.' });
  }

  const rotation = parseInt(req.body.rotation, 10) || 0;
  const width = parseInt(req.body.width, 10) || 1366;
  const height = parseInt(req.body.height, 10) || 768;

  const inputPath = req.file.path;
  const outputFileName = `converted_${Date.now()}.jpg`;
  const outputPath = path.join(OUTPUT_DIR, outputFileName);

  const args = [inputPath];

  if (rotation !== 0) {
    args.push('-rotate', String(rotation));
  }

  args.push(
    '-resize', `${width}x${height}^`,
    '-gravity', 'center',
    '-extent', `${width}x${height}`,
    outputPath
  );

  console.log('Comando magick:', IMAGEMAGICK_PATH, args.join(' '));

  const magickProcess = spawn(IMAGEMAGICK_PATH, args);

  let stderrLog = '';
  magickProcess.stderr.on('data', (data) => {
    stderrLog += data.toString();
  });

  magickProcess.on('error', (err) => {
    console.error('Errore avvio magick:', err);
    cleanupUpload(inputPath);
    res.status(500).json({
      error: 'Impossibile avviare ImageMagick. Controlla il percorso (IMAGEMAGICK_PATH).',
      details: err.message
    });
  });

  magickProcess.on('close', (code) => {
    cleanupUpload(inputPath);

    if (code !== 0) {
      console.error('magick terminato con errore, log:', stderrLog);
      return res.status(500).json({
        error: 'Conversione immagine fallita.',
        magickLog: stderrLog
      });
    }

    res.download(outputPath, 'immagine_techla.jpg', (err) => {
      fs.unlink(outputPath, () => {});
      if (err) console.error('Errore invio file:', err);
    });
  });
});

app.listen(PORT, () => {
  console.log(`Server in ascolto su http://localhost:${PORT}`);
  console.log(`FFmpeg path: ${FFMPEG_PATH}`);
});
