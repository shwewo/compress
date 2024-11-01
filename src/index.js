const express = require("express");
const rateLimit = require("express-rate-limit");
const basicAuth = require("express-basic-auth");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { spawn } = require("child_process");
const { exit } = require("process");

const MAX_EXECUTION_TIME = 60 * 1000;
const AGE_LIMIT = 15 * 60 * 1000;

const FFPROBE_PATH = process.env.FFPROBE_PATH || "ffprobe";
const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";
const LOGIN = process.env.LOGIN || "user";
const PASSWORD = process.env.PASSWORD || "password";
const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.resolve(process.cwd(), "uploads");
let STATIC_PATH = process.env.STATIC_PATH;

if (!process.env.LOGIN && !process.env.PASSWORD) {
  console.warn("Warning, using default credentials: `user:password`");
}

const app = express();
app.use(
  basicAuth({
    users: { [LOGIN]: PASSWORD },
    challenge: true,
  }),
);

if (!STATIC_PATH) {
  const staticVariant1 = path.resolve(path.dirname(__filename), "static");
  const staticVariant2 = path.resolve(process.cwd(), "static");

  if (fs.existsSync(staticVariant1)) {
    STATIC_PATH = staticVariant1;
  } else if (fs.existsSync(staticVariant2)) {
    STATIC_PATH = staticVariant2;
  } else {
    console.error("STATIC_PATH not found, exiting");
    exit(1);
  }
}
app.use(express.static(STATIC_PATH));

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR);
}

const limiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 3,
  message: {
    error: "Too many requests from this IP, please try again later.",
  },
  keyGenerator: function (req) {
    return req.headers["cf-connecting-ip"] || req.ip;
  },
}); // 3 requests per minute

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    cb(null, uuidv4() + path.extname(file.originalname));
  },
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 200 * 1024 * 1024 },
});

const store = {};

function deleteOldFiles() {
  fs.readdir(UPLOADS_DIR, (err, files) => {
    if (err) {
      return console.error("Unable to scan directory: " + err);
    }

    const now = Date.now();

    files.forEach((file) => {
      const filePath = path.join(UPLOADS_DIR, file);

      fs.stat(filePath, (err, stats) => {
        if (err) {
          return console.error("Unable to get file stats: " + err);
        }

        if (now - stats.mtimeMs > AGE_LIMIT) {
          fs.unlink(filePath, (err) => {
            if (err) {
              return console.error("Unable to delete file: " + err);
            }
            console.log(`Purged: ${filePath}`);
          });
        }
      });
    });
  });
}

async function ffprobeVideo(inputFile) {
  return new Promise((resolve, reject) => {
    const args = ["-v", "error", "-show_format", "-show_streams", "-print_format", "json", inputFile];
    const ffprobe = spawn(FFPROBE_PATH, args);
    let output = "";
    let stderr = "";

    ffprobe.stdout.on("data", (data) => {
      output += data.toString();
    });

    ffprobe.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    ffprobe.on("exit", (code) => {
      if (code == 0) {
        try {
          resolve(JSON.parse(output));
        } catch (err) {
          reject(new Error(`ffprobe ${inputFile}: JSON parse error ${err}`));
        }
      } else {
        reject(new Error(`ffprobe ${inputFile}: Exited with code ${code} stderr: ${stderr}`));
      }
    });
  });
}

async function createThumbnail(uuid, inputFile) {
  return new Promise((resolve, reject) => {
    const filename = `${uuid}.webp`;
    const outputFile = `${UPLOADS_DIR}/${filename}`;
    const args = ["-i", inputFile, "-y", "-update", "true", "-vframes", "1", "-ss", "00:00:00", outputFile];
    const ffmpeg = spawn(FFMPEG_PATH, args);
    let stderr = "";

    ffmpeg.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    ffmpeg.on("exit", (code) => {
      if (code == 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg ${outputFile}: Exited with code ${code} stderr: ${stderr}`));
      }
    });
  });
}

async function parseFfmpegTime(time) {
  return new Promise((resolve) => {
    try {
      const timeParts = time.split(":");
      const hours = parseInt(timeParts[0], 10);
      const minutes = parseInt(timeParts[1], 10);
      const seconds = parseFloat(timeParts[2]);
      durationSeconds = hours * 3600.0 + minutes * 60.0 + seconds;
      resolve(durationSeconds);
    } catch (err) {
      resolve(0.0);
    }
  });
}

async function ffmpegPass(uuid, duration, pass, videoCodec, videoBitrate, audioBitrate, inputFile, outputFile) {
  return new Promise((resolve, reject) => {
    const argsFirstPass = ["-v", "error", "-progress", "-", "-y", "-i", inputFile, "-c:v", videoCodec, "-c:a", "libopus", "-preset", "medium", "-f", "mp4", "-pass", "1", "-passlogfile", `${UPLOADS_DIR}/${uuid}.log`, "-b:v", `${videoBitrate}k`, "-b:a", `${audioBitrate}k`, outputFile];
    const argsSecondPass = ["-v", "error", "-progress", "-", "-y", "-i", inputFile, "-c:v", videoCodec, "-c:a", "libopus", "-preset", "medium", "-pass", "2", "-passlogfile", `${UPLOADS_DIR}/${uuid}.log`, "-b:v", `${videoBitrate}k`, "-b:a", `${audioBitrate}k`, outputFile];

    const ffmpeg = spawn(FFMPEG_PATH, pass == 1 ? argsFirstPass : argsSecondPass);
    let stderr = "";

    const timeoutId = setTimeout(() => {
      ffmpeg.kill();
      reject(new Error(`Process timed out after ${MAX_EXECUTION_TIME} ms`));
    }, MAX_EXECUTION_TIME);

    ffmpeg.stdout.on("data", async (data) => {
      const lines = data.toString().split("\n");

      for (const line of lines) {
        if (line.startsWith("out_time=")) {
          const outTime = line.split("=")[1].trim();

          if (pass == 1) {
            store[uuid].progress = Math.ceil((((await parseFfmpegTime(outTime)) / duration) * 100.0) / 2.0);
          } else {
            store[uuid].progress = Math.ceil((((await parseFfmpegTime(outTime)) / duration) * 100.0) / 2.0 + 50);
          }
        }
      }
    });

    ffmpeg.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    ffmpeg.on("exit", (code) => {
      clearTimeout(timeoutId);
      if (code == 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg ${uuid}: Exited with code ${code} stderr: ${stderr}`));
      }
    });
  });
}

app.get("/:file", async (req, res) => {
  if (req.params.file) {
    const uuid = path.basename(req.params.file, path.extname(req.params.file));
    const thumbnail = `${path.basename(req.params.file, path.extname(req.params.file))}.webp`;
    let filename;

    if (path.extname(req.params.file) == ".mp4") {
      filename = `${path.basename(req.params.file, path.extname(req.params.file))}_2${path.extname(req.params.file)}`;
    } else {
      filename = req.params.file;
    }

    const requestedPath = path.resolve(UPLOADS_DIR, filename);
    const requestedPathThumbnail = path.resolve(UPLOADS_DIR, thumbnail);

    if (!requestedPath.startsWith(UPLOADS_DIR) && !requestedPathThumbnail.startsWith(UPLOADS_DIR)) {
      return res.status(403).json({
        error: "Access denied",
      });
    }

    res.download(requestedPath, req.params.file, (err) => {
      if (err) {
        if (!res.headersSent) {
          res.status(404).json({
            error: "File not found",
          });
        }
      } else {
        if (path.extname(req.params.file) == ".mp4") {
          fs.unlinkSync(requestedPath);
          fs.unlinkSync(requestedPathThumbnail);
          store[uuid] = undefined;
        }
      }
    });
  } else {
    res.status(400).json({
      error: "Invalid UUID",
    });
  }
});

app.get("/api/ping", async (req, res) => {
  res.status(200).json({
    status: "OK",
  });
});

app.get("/api/status/:uuid", async (req, res) => {
  if (req.params.uuid && store[req.params.uuid]) {
    res.status(200).json(store[req.params.uuid]);
  } else {
    res.status(400).json({
      error: "Invalid UUID",
    });
  }
});

app.post("/api/transcode", limiter, upload.single("video"), async (req, res) => {
  let inputFile;
  let targetSizeMB;
  let videoCodec;
  let ffprobeData;
  let videoFound = false;
  let audioFound = false;
  let audioBitrateKbps = 0.0;
  let uuid;

  if (req.file) {
    inputFile = req.file.path;
  } else {
    return res.status(400).json({
      error: "No file given",
    });
  }

  uuid = path.basename(inputFile, path.extname(inputFile));

  if (req.body.targetSize) {
    targetSizeMB = parseInt(req.body.targetSize);
  } else {
    return res.status(400).json({
      error: "No target size given",
    });
  }

  if (req.body.videoCodec) {
    if (req.body.videoCodec === "libx264" || req.body.videoCodec === "libx265") {
      videoCodec = req.body.videoCodec;
    } else {
      return res.status(400).json({
        error: "Invalid video codec",
      });
    }
  } else {
    return res.status(400).json({
      error: "No video codec given",
    });
  }

  const currentFileSizeMB = Math.round(fs.statSync(inputFile).size / (1000.0 * 1000.0));
  if (currentFileSizeMB <= targetSizeMB) {
    return res.status(400).json({
      error: `File size is lower than target size: ${currentFileSizeMB}MB`,
    });
  }

  try {
    ffprobeData = await ffprobeVideo(inputFile);
  } catch (err) {
    console.error(`${uuid}: ffprobe failed`);
    return res.status(500).json({
      error: "ffprobe failed",
    });
  }

  for (let i = 0; i < ffprobeData.streams.length; i++) {
    if (ffprobeData.streams[i].codec_type == "video") {
      videoFound = true;
    }

    if (ffprobeData.streams[i].codec_type == "audio") {
      audioFound = true;
      if (ffprobeData.streams[i].bit_rate) {
        audioBitrateKbps = Math.round(parseFloat(ffprobeData.streams[i].bit_rate) / 1000.0);
      } else {
        audioBitrateKbps = 128.0;
      }
    }

    if (videoFound && audioFound) {
      break;
    }
  }

  if (!videoFound) {
    console.error(`${uuid}: No video streams found`);
    return res.status(400).json({
      error: "No video streams found",
    });
  }

  try {
    await createThumbnail(uuid, inputFile);
  } catch (err) {
    console.error(`${uuid}: Error while generating thumbnail ${err}`);
  }

  const durationSec = parseFloat(ffprobeData.format.duration);
  const targetSizeKilobits = targetSizeMB * 8000.0;
  const videoBitrateKbps = Math.round(targetSizeKilobits / durationSec - audioBitrateKbps);

  if (videoBitrateKbps <= 384.0) {
    console.error(`${uuid}: Unrealistic video bitrate ${videoBitrateKbps} kbps`);
    return res.status(500).json({
      error: `Unrealistic video bitrate ${videoBitrateKbps} kbps`,
    });
  }

  console.log(`${uuid}: Target size ${targetSizeMB}MB Calculated video bitrate ${videoBitrateKbps} kbps Audio bitrate ${audioBitrateKbps} kbps`);
  store[uuid] = {
    status: "Transcoding",
    progress: 0,
    targetSize: targetSizeMB,
    videoBitrateKbps: videoBitrateKbps,
    audioBitrateKbps: audioBitrateKbps,
    uuid: uuid,
  };
  res.status(200).json(store[uuid]);

  try {
    const firstPassOutputFile = `${UPLOADS_DIR}/${path.basename(inputFile, path.extname(inputFile))}_1.mp4`;
    const secondPassOutputFile = `${UPLOADS_DIR}/${path.basename(inputFile, path.extname(inputFile))}_2.mp4`;

    await ffmpegPass(uuid, durationSec, 1, videoCodec, videoBitrateKbps, audioBitrateKbps, inputFile, firstPassOutputFile);
    await ffmpegPass(uuid, durationSec, 2, videoCodec, videoBitrateKbps, audioBitrateKbps, firstPassOutputFile, secondPassOutputFile);

    store[uuid].progress = 100;
    store[uuid].status = "Done";

    fs.unlinkSync(inputFile);
    fs.unlinkSync(firstPassOutputFile);
    console.log(`${uuid}: Transcoded successfully`);
  } catch (err) {
    store[uuid].status = "Error";
    console.error(`${uuid}: Transcode failed ${err}`);
  }
});

deleteOldFiles();
setInterval(deleteOldFiles, 10 * 60 * 1000);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server is running on http://0.0.0.0:${PORT}`);
  console.log(`Uploads directory ${UPLOADS_DIR}`);
});
