const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();
app.use(express.json());
app.set("json spaces", 2);

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

  const { data } = await axios.post("https://v3.fastdl.app/api/ajaxSearch", form, {
    headers: {
      "Accept": "application/json, text/javascript, */*; q=0.01",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36",
      "X-Requested-With": "XMLHttpRequest"
    }
  });

  const htmlData = data && (data.data || data.html || data);
  if (typeof htmlData !== "string") {
    throw new Error("Respon dari provider Instagram tidak berupa teks HTML.");
  }

  const $ = cheerio.load(htmlData);
  const mediaList = [];

  $("a.download-items__btn, a[title='Download Video'], a[title='Download Image']").each((i, el) => {
    const link = $(el).attr("href");
    if (link && !link.startsWith("javascript")) {
      mediaList.push(link);
    }
  });

  if (!mediaList.length) {
    $("a").each((i, el) => {
      const href = $(el).attr("href");
      if (href && (href.includes(".mp4") || href.includes(".jpg") || href.includes("https://dl.snapcdn.app"))) {
        mediaList.push(href);
      }
    });
  }

  if (!mediaList.length) throw new Error("Media Instagram tidak ditemukan.");

  const isVideo = mediaList[0].includes(".mp4") || mediaList[0].includes("video");

  return {
    status: true,
    result: {
      type: isVideo ? "video" : "image",
      url: mediaList[0],
      all_media: mediaList
    }
  };
}

app.get("/api/tiktok", async (req, res) => {
  const { url } = req.query;
  if (!url) {
    return res.status(400).setHeader("Content-Type", "application/json").send(
      JSON.stringify({ status: false, message: "Parameter 'url' wajib diisi." }, null, 2)
    );
  }

  try {
    const data = await tiktokio(url);
    return res.setHeader("Content-Type", "application/json").send(
      JSON.stringify(data, null, 2)
    );
  } catch (error) {
    return res.status(500).setHeader("Content-Type", "application/json").send(
      JSON.stringify({ status: false, message: "Gagal memproses TikTok.", error: error.message }, null, 2)
    );
  }
});

app.get("/api/instagram", async (req, res) => {
  const { url } = req.query;
  if (!url) {
    return res.status(400).setHeader("Content-Type", "application/json").send(
      JSON.stringify({ status: false, message: "Parameter 'url' wajib diisi." }, null, 2)
    );
  }

  try {
    const data = await downloadInstagram(url);
    return res.setHeader("Content-Type", "application/json").send(
      JSON.stringify(data, null, 2)
    );
  } catch (error) {
    return res.status(500).setHeader("Content-Type", "application/json").send(
      JSON.stringify({ status: false, message: "Gagal memproses Instagram.", error: error.message }, null, 2)
    );
  }
});

module.exports = app;
