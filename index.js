const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();
app.use(express.json());
app.set("json spaces", 2);

const PATH_REGEX = /instagram\.com\/(p|reel|reels)\/([a-zA-Z0-9_-]+)/;

function toBase64Url(str) {
  return Buffer.from(str, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(str) {
  let s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64").toString("utf-8");
}

function sanitizeFilename(name) {
  if (!name) return "";
  return name
    .replace(/[\/\\?%*:|"<>\r\n]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function extFor(type) {
  const map = { video: "mp4", image: "jpg", audio: "mp3" };
  return map[type] || "bin";
}

function guessFilename(type, titleHint) {
  const ext = extFor(type);
  const clean = sanitizeFilename(titleHint);
  const base = clean ? `danzclean_${clean}` : `danzclean_${type || "file"}`;
  return `${base}.${ext}`;
}

// Wraps a real media URL into our own /api/dl link so the user never sees the original host,
// and gives the file a real name (from the video title / caption) instead of a generic one.
function buildProxyUrl(req, originalUrl, type, titleHint) {
  if (!originalUrl) return null;
  const base = `${req.protocol}://${req.get("host")}`;
  const token = toBase64Url(originalUrl);
  const params = new URLSearchParams({ u: token, n: guessFilename(type, titleHint) });
  return `${base}/api/dl?${params.toString()}`;
}

function extractShortcode(url) {
  if (!url) return null;
  const match = url.match(PATH_REGEX);
  return match ? match[2] : null;
}

function extractPath(url) {
  if (!url) return "p";
  const match = url.match(PATH_REGEX);
  const raw = match ? match[1] : "p";
  return raw === "reels" ? "reel" : raw;
}

function extractEmbedData(html) {
  const handleMatch = html.match(/s\.handle\(\s*(\{.*?\})\s*\)\s*;/);
  if (!handleMatch) return null;
  const outer = JSON.parse(handleMatch[1]);
  const embedData = outer?.require?.[1]?.[3]?.[0];
  if (!embedData?.contextJSON) return null;
  const parsed = JSON.parse(embedData.contextJSON);
  const item = parsed?.gql_data?.shortcode_media;
  if (!item) return null;
  const user = item.owner || {};
  const caption = item.edge_media_to_caption?.edges?.[0]?.node?.text || item.caption || "";
  return {
    caption,
    username: user.username || "N/A",
    url: item.video_url || item.display_url || "",
    isVideo: !!item.is_video,
  };
}

function extractSlideData(html) {
  const idx = html.indexOf('"xig_polaris_media"');
  if (idx === -1) return null;
  const start = html.lastIndexOf('{"__bbox"', idx);
  if (start === -1) return null;
  let depth = 1, end = start + 8;
  for (; end < html.length; end++) {
    if (html[end] === "{") depth++;
    if (html[end] === "}") depth--;
    if (depth === 0) { end++; break; }
  }
  let bbox;
  try {
    bbox = JSON.parse(html.slice(start, end));
  } catch {
    return null;
  }
  const xig = bbox?.__bbox?.result?.data?.xig_polaris_media;
  if (!xig) return null;
  return xig.if_not_gated_logged_out || xig;
}

function extractMetaData(html) {
  const getMeta = (prop) => {
    const reg = new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["]([^"]+)["]`);
    const m = html.match(reg);
    return m ? m[1].replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#\d+;/g, "") : "";
  };
  const imageUrl = getMeta("og:image");
  if (!imageUrl) return null;
  const desc = getMeta("og:description");
  const usernameMatch = html.match(/instagram\.com\/([^\/\s"']+)\/p\//);
  const username = usernameMatch ? usernameMatch[1] : "N/A";
  let caption = desc;
  const likeMatch = desc.match(/([\d,.]+)\s+likes/);
  const commentMatch = desc.match(/([\d,.]+)\s+comments/);
  if (likeMatch || commentMatch) {
    const prefix = `${likeMatch?.[1] || "0"} likes, ${commentMatch?.[1] || "0"} comments - `;
    caption = desc.replace(prefix, "").trim();
  }
  return {
    caption,
    username,
    url: imageUrl,
    isVideo: false,
  };
}

function buildVideoResult(raw) {
  const versions = raw.video_versions || [];
  const user = raw.user || {};
  const captionObj = raw.caption || {};
  const caption = captionObj.text || raw.accessibility_caption || "";
  const bestVideo = versions[0]?.url || raw.video_url || "";

  return {
    status: true,
    result: {
      type: "video",
      caption,
      username: user.username || "N/A",
      url: bestVideo,
    },
  };
}

function buildSlidesResult(raw) {
  const user = raw.user || {};
  const captionObj = raw.caption || {};
  const caption = captionObj.text || raw.accessibility_caption || "";
  const items = raw.carousel_media || [];

  if (!items.length) {
    const bestImg = raw.image_versions2?.candidates?.[0]?.url || raw.display_uri || "";
    const bestVid = raw.video_versions?.[0]?.url || "";
    return {
      status: true,
      result: {
        type: bestVid ? "video" : "image",
        caption,
        username: user.username || "N/A",
        url: bestVid || bestImg,
      },
    };
  }

  const firstItem = items[0];
  const bestVid = firstItem.video_versions?.[0]?.url;
  const bestImg = firstItem.image_versions2?.candidates?.[0]?.url || firstItem.display_uri;

  return {
    status: true,
    result: {
      type: bestVid ? "video" : "image",
      caption,
      username: user.username || "N/A",
      url: bestVid || bestImg,
    },
  };
}

function createCookieJar() {
  let jar = "";
  function parseSetCookie(val) {
    return (val || "").split(",").map(c => c.split(";")[0].trim()).filter(Boolean).join("; ");
  }
  return {
    getCookies() { return jar; },
    setCookies(setCookie) { jar = parseSetCookie(setCookie); },
    async init(ua) {
      const res = await fetch("https://www.instagram.com/", {
        headers: {
          "User-Agent": ua,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "none",
          "Sec-Fetch-User": "?1",
          "Upgrade-Insecure-Requests": "1",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
      });
      this.setCookies(res.headers.get("set-cookie"));
      return jar;
    },
    async fetch(url, extra = {}) {
      const headers = {
        "User-Agent": extra.ua || "Mozilla/5.0 (Linux; Android 15; 25028RN03A) AppleWebKit/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
        "Upgrade-Insecure-Requests": "1",
        ...(extra.headers || {}),
      };
      if (jar) headers.Cookie = jar;
      const res = await fetch(url, {
        headers,
        signal: extra.signal || AbortSignal.timeout(15000),
      });
      const newCookies = res.headers.get("set-cookie");
      if (newCookies) this.setCookies(newCookies);
      return res;
    },
  };
}

const instagram = {
  video: async (url) => {
    const shortcode = extractShortcode(url);
    if (!shortcode) return { status: false, error: "URL tidak valid atau shortcode tidak ditemukan." };
    try {
      const ua = "Mozilla/5.0 (Linux; Android 15; 25028RN03A) AppleWebKit/537.36";
      const jar = createCookieJar();
      const path = extractPath(url);
      const mainRes = await jar.fetch(`https://www.instagram.com/${path}/${shortcode}/`, { ua });
      let html = await mainRes.text();
      let raw = extractSlideData(html);
      if (!raw) {
        await jar.init(ua);
        const retryRes = await jar.fetch(`https://www.instagram.com/${path}/${shortcode}/`, { ua });
        html = await retryRes.text();
        raw = extractSlideData(html);
      }
      if (raw) {
        const vidData = buildVideoResult(raw);
        if (vidData.result.url) return vidData;
      }
      const embedRes = await jar.fetch(`https://www.instagram.com/${path}/${shortcode}/embed/captioned/`, { ua });
      html = await embedRes.text();
      const data = extractEmbedData(html);
      if (!data) throw new Error("Data video tidak ditemukan.");
      if (!data.url) throw new Error("Post ini tidak memiliki media.");
      return {
        status: true,
        result: {
          type: data.isVideo ? "video" : "image",
          caption: data.caption,
          username: data.username,
          url: data.url,
        },
      };
    } catch (error) {
      return { status: false, error: error.message };
    }
  },
  slide: async (url) => {
    const shortcode = extractShortcode(url);
    if (!shortcode) return { status: false, error: "URL tidak valid atau shortcode tidak ditemukan." };
    try {
      const ua = "Mozilla/5.0 (Linux; Android 15; 25028RN03A) AppleWebKit/537.36";
      const jar = createCookieJar();
      const mainRes = await jar.fetch(`https://www.instagram.com/p/${shortcode}/?img_index=2`, { ua });
      let html = await mainRes.text();
      let raw = extractSlideData(html);
      if (!raw) {
        await jar.init(ua);
        const retryRes = await jar.fetch(`https://www.instagram.com/p/${shortcode}/?img_index=2`, { ua });
        html = await retryRes.text();
        raw = extractSlideData(html);
      }
      if (!raw) {
        const embedRes = await jar.fetch(`https://www.instagram.com/p/${shortcode}/embed/captioned/`, { ua });
        html = await embedRes.text();
        let data = extractEmbedData(html);
        if (!data) {
          const fallbackRes = await jar.fetch(`https://www.instagram.com/p/${shortcode}/`, { ua });
          html = await fallbackRes.text();
          data = extractMetaData(html);
        }
        if (!data) throw new Error("Data slide tidak ditemukan.");
        return {
          status: true,
          result: {
            type: "image",
            caption: data.caption,
            username: data.username,
            url: data.url,
          },
        };
      }
      return buildSlidesResult(raw);
    } catch (error) {
      return { status: false, error: error.message };
    }
  },
};

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
        "user-agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36",
      },
    }
  );

  const $ = cheerio.load(res.data);
  const title = $(".video-info h3").first().text().trim();
  const cover = $(".video-info img").first().attr("src") || null;

  const images = [];
  $(".image-item").each((i, el) => {
    const link = $(el).find("a").attr("href");
    if (link) images.push(link);
  });

  const links = {};
  $(".download-links a").each((i, el) => {
    const text = $(el).text().toLowerCase();
    const href = $(el).attr("href");
    if (text.includes("without watermark") && !text.includes("hd")) links.nowm = href;
    else if (text.includes("hd")) links.nowm_hd = href;
    else if (text.includes("mp3")) links.mp3 = href;
  });

  const isImage = images.length > 0;

  return {
    status: true,
    result: {
      title,
      type: isImage ? "image" : "video",
      cover,
      url: isImage ? null : (links.nowm_hd || links.nowm || null),
      images: isImage ? images : null,
      audio: links.mp3 || null,
    },
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

    if (data.status && data.result) {
      const r = data.result;
      if (r.url) r.url = buildProxyUrl(req, r.url, r.type, r.title);
      if (r.cover) r.cover = buildProxyUrl(req, r.cover, "image", r.title);
      if (r.audio) r.audio = buildProxyUrl(req, r.audio, "audio", r.title);
      if (Array.isArray(r.images)) {
        r.images = r.images.map((img) => buildProxyUrl(req, img, "image", r.title));
      }
    }

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
    let data = await instagram.video(url);
    if (!data.status || !data.result?.url) {
      data = await instagram.slide(url);
    }

    if (!data.status) {
      return res.status(500).setHeader("Content-Type", "application/json").send(
        JSON.stringify({ status: false, message: "Gagal memproses Instagram.", error: data.error }, null, 2)
      );
    }

    if (data.result?.url) {
      data.result.url = buildProxyUrl(req, data.result.url, data.result.type, data.result.caption);
    }

    return res.setHeader("Content-Type", "application/json").send(
      JSON.stringify(data, null, 2)
    );
  } catch (error) {
    return res.status(500).setHeader("Content-Type", "application/json").send(
      JSON.stringify({ status: false, message: "Gagal memproses Instagram.", error: error.message }, null, 2)
    );
  }
});

// Streams the file through our server so we control the filename (Content-Disposition).
// Falls back to a 302 redirect if the upstream fetch fails, so a download link never dies.
app.get("/api/dl", async (req, res) => {
  const { u, n } = req.query;
  if (!u) {
    return res.status(400).setHeader("Content-Type", "application/json").send(
      JSON.stringify({ status: false, message: "Parameter 'u' wajib diisi." }, null, 2)
    );
  }

  let originalUrl;
  try {
    originalUrl = fromBase64Url(u);
    new URL(originalUrl);
  } catch {
    return res.status(400).setHeader("Content-Type", "application/json").send(
      JSON.stringify({ status: false, message: "Token tidak valid." }, null, 2)
    );
  }

  let referer;
  if (/instagram|cdninstagram|fbcdn/i.test(originalUrl)) referer = "https://www.instagram.com/";
  else if (/tiktok/i.test(originalUrl)) referer = "https://www.tiktok.com/";

  const filename = n || originalUrl.split("/").pop().split("?")[0] || "file";

  try {
    const upstream = await axios.get(originalUrl, {
      responseType: "stream",
      maxRedirects: 5,
      timeout: 30000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36",
        ...(referer ? { Referer: referer } : {}),
      },
      validateStatus: (s) => s >= 200 && s < 400,
    });

    res.setHeader("Content-Type", upstream.headers["content-type"] || "application/octet-stream");
    if (upstream.headers["content-length"]) {
      res.setHeader("Content-Length", upstream.headers["content-length"]);
    }
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    upstream.data.pipe(res);
    upstream.data.on("error", () => {
      if (!res.headersSent) res.redirect(302, originalUrl);
      else res.end();
    });
  } catch {
    // Streaming failed (timeout, size limit, upstream block, etc) — fall back to a plain redirect
    // so the user can still get the file, just without our custom filename.
    return res.redirect(302, originalUrl);
  }
});

module.exports = app;
