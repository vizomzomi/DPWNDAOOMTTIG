const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();
app.use(express.json());

async function tiktokio(url) {
  const res = await axios.post(
    "https://tiktokio.com/api/v1/tk/html",
    { vid: url, prefix: "tiktokio.com" },
    {
      headers: {
        "accept": "*/*",
        "content-type": "application/json",
        "origin": "https://tiktokio.com",
        "referer": "https://tiktokio.com/id/pengunduh-douyin/",
        "user-agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36"
      }
    }
  );

  const $ = cheerio.load(res.data);
  const title = $(".video-info h3").first().text().trim();
  const cover = $(".video-info img").first().attr("src") || null;

  const images = [];
  $(".image-item").each((i, el) => {
    const img = $(el).find("img").attr("src");
    const link = $(el).find("a").attr("href");
    if (img) images.push({ thumbnail: img, download: link });
  });

  const links = {};
  $(".download-links a").each((i, el) => {
    const text = $(el).text().toLowerCase();
    const href = $(el).attr("href");
    if (text.includes("without watermark") && !text.includes("hd")) links.nowm = href;
    else if (text.includes("hd")) links.nowm_hd = href;
    else if (text.includes("watermark")) links.wm = href;
    else if (text.includes("mp3")) links.mp3 = href;
  });

  return {
    status: true,
    result: {
      title,
      type: images.length ? "image" : "video",
      cover,
      images,
      video: images.length ? null : links,
      audio: links.mp3 || null
    }
  };
}

async function downloadInstagram(url) {
  const form = new URLSearchParams();
  form.append("q", url);
  form.append("vt", "home");

  const { data } = await axios.post("https://yt5s.io/api/ajaxSearch", form, {
    headers: {
      "Accept": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });

  if (data.status !== "ok") throw new Error("Gagal mengambil data Instagram.");

  const $ = cheerio.load(data.data);
  const video = $('a[title="Download Video"]').attr("href");
  const image = $("img").attr("src");

  if (video) {
    return { status: true, result: { type: "video", url: video } };
  } else if (image) {
    return { status: true, result: { type: "image", url: image } };
  }

  throw new Error("Media Instagram tidak ditemukan.");
}

app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(`
    <!DOCTYPE html>
    <html lang="id">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>API Downloader UI</title>
      <style>
        body { font-family: sans-serif; background: #121212; color: #fff; padding: 20px; }
        .container { max-width: 600px; margin: auto; }
        input, select, button { width: 100%; padding: 10px; margin-top: 10px; box-sizing: border-box; border-radius: 5px; border: 1px solid #333; }
        button { background: #0070f3; color: white; font-weight: bold; cursor: pointer; border: none; }
        .checkbox-container { margin-top: 15px; display: flex; align-items: center; gap: 8px; font-size: 14px; }
        pre { background: #1e1e1e; padding: 15px; border-radius: 5px; overflow-x: auto; white-space: pre-wrap; word-wrap: break-word; color: #00ff66; margin-top: 15px; }
      </style>
    </head>
    <body>
      <div class="container">
        <h2>API Media Downloader</h2>
        <select id="platform">
          <option value="tiktok">TikTok</option>
          <option value="instagram">Instagram</option>
        </select>
        <input type="text" id="urlInput" placeholder="Masukkan URL postingan...">
        <button onclick="fetchData()">Get Data</button>
        
        <div class="checkbox-container">
          <input type="checkbox" id="prettyCheck" checked onchange="renderResult()">
          <label for="prettyCheck">Format Rapi (Pretty JSON)</label>
        </div>

        <pre id="output">Masukkan URL dan klik Get Data...</pre>
      </div>

      <script>
        let rawData = null;

        async function fetchData() {
          const platform = document.getElementById('platform').value;
          const url = document.getElementById('urlInput').value;
          const output = document.getElementById('output');

          if (!url) {
            output.innerText = "Masukkan URL terlebih dahulu!";
            return;
          }

          output.innerText = "Processing...";
          try {
            const res = await fetch(\`/api/\${platform}?url=\${encodeURIComponent(url)}\`);
            rawData = await res.json();
            renderResult();
          } catch (err) {
            output.innerText = "Error: " + err.message;
          }
        }

        function renderResult() {
          if (!rawData) return;
          const isPretty = document.getElementById('prettyCheck').checked;
          const output = document.getElementById('output');
          output.innerText = isPretty ? JSON.stringify(rawData, null, 2) : JSON.stringify(rawData);
        }
      </script>
    </body>
    </html>
  `);
});

app.get("/api/tiktok", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ status: false, message: "Parameter 'url' wajib diisi." });

  try {
    const data = await tiktokio(url);
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ status: false, message: "Gagal memproses TikTok.", error: error.message });
  }
});

app.get("/api/instagram", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ status: false, message: "Parameter 'url' wajib diisi." });

  try {
    const data = await downloadInstagram(url);
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ status: false, message: "Gagal memproses Instagram.", error: error.message });
  }
});

module.exports = app;
