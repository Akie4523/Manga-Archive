require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const app = express();

// --- 1. Middleware & Config ---
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// --- 2. เชื่อมต่อ MongoDB Atlas ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ Connected to MongoDB"))
    .catch(err => console.error("❌ MongoDB Error:", err));

// --- 3. Database Schemas ---
const Manga = mongoose.model('Manga', new mongoose.Schema({
    id: String, title: String, cover: String, description: String, tags: [String],
    rating: String, jp_name: String, en_name: String, th_name: String,
    author: String, artist: String, translator: String, translator_link: String,
    thai_url: String, eng_url: String, original_url: String, updated_at: String
}));

const User = mongoose.model('User', new mongoose.Schema({
    username: { type: String, unique: true },
    password: { type: String },
    favorites: [String]
}));

// --- 4. Auth Middleware ---
const auth = (req, res, next) => {
    if (req.method === 'OPTIONS') return next();
    const token = req.headers['authorization'];
    if (token === process.env.SECRET_TOKEN) {
        next();
    } else {
        res.status(403).json({ message: "Forbidden: กุญแจไม่ถูกต้อง" });
    }
};

// --- 5. Security & Scraper Helpers ---
const isWhitelisted = (url) => {
    try {
        const domain = new URL(url).hostname;
        const allowed = ['fluxtoon.com', 'mangaisekaithai.net', 'facebook.com', 'nekopost.net'];
        return allowed.some(d => domain.includes(d));
    } catch (e) { return false; }
};

const puppeteerOptions = {
    headless: "new",
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled', // ปิดการส่งสัญญาณว่าเป็น Bot
        '--disable-infobars',
        '--window-size=1280,720',
        '--lang=en-US,en;q=0.9'
    ]
};
// ฟังก์ชันช่วยเลื่อนหน้าจอเพื่อให้เนื้อหาโหลดครบ
async function autoScroll(page) {
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            let distance = 150;
            let timer = setInterval(() => {
                let scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;
                if (totalHeight >= scrollHeight) {
                    clearInterval(timer);
                    resolve();
                }
            }, 100);
        });
    });
}

// --- 6. API Routes (ข้อมูลทั่วไป) ---
app.get("/ping", (req, res) => res.status(200).send("OK"));

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await User.findOne({ username });
        if (!user || user.password !== password) {
            return res.status(401).json({ success: false, message: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" });
        }
        res.json({
            success: true,
            token: process.env.SECRET_TOKEN,
            username: user.username,
            favorites: user.favorites
        });
    } catch (e) { res.status(500).send(e.message); }
});

app.get("/manga", async (req, res) => {
    const mangas = await Manga.find().sort({ _id: -1 }); 
    res.json(mangas);
});

app.get("/api/manga/:id", async (req, res) => {
    try {
        const { id } = req.params;
        let manga = await Manga.findById(id).catch(() => null);
        if (!manga) manga = await Manga.findOne({ id: id });
        if (!manga) return res.status(404).json({ message: "ไม่พบมังงะ" });
        res.json(manga);
    } catch (err) { res.status(500).json({ message: "Error fetching manga" }); }
});

app.put('/api/manga/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const updateData = req.body;

        // ค้นหาด้วย ID และอัปเดตข้อมูลใหม่
        const updatedManga = await Manga.findOneAndUpdate(
            { id: id }, 
            updateData, 
            { new: true } // ให้คืนค่าข้อมูลที่อัปเดตแล้วกลับมา
        );

        if (!updatedManga) {
            return res.status(404).json({ message: "ไม่พบมังงะที่ต้องการแก้ไข" });
        }

        console.log(`✅ Updated Manga ID: ${id}`);
        res.json({ success: true, manga: updatedManga });
    } catch (err) {
        console.error("❌ Update Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// --- 7. API Routes (ระบบ Scraper ปรับปรุงใหม่) ---

app.get('/api/fetch-chapters', async (req, res) => {
    const { url } = req.query;
    if (!isWhitelisted(url)) return res.status(403).json({ error: "Access Denied" });

    let browser;
    try {
        console.log(`🚀 เริ่มภารกิจดึงข้อมูล: ${url}`);
        browser = await puppeteer.launch(puppeteerOptions);
        const page = await browser.newPage();
        
        // กำหนด User Agent ให้เหมือน Chrome บน Windows จริงๆ
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36');
        
        // ลบคุณสมบัติ navigator.webdriver เพื่อหลบการตรวจจับ
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });

        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

        // --- ระบบรอ Cloudflare ปลดล็อค ---
        let currentTitle = await page.title();
        let retry = 0;
        while (currentTitle.includes("Just a moment") && retry < 10) {
            console.log(`⏳ ติดด่าน Cloudflare... กำลังรอรอบที่ ${retry + 1}`);
            await new Promise(r => setTimeout(r, 2000)); // รอทีละ 2 วินาที
            currentTitle = await page.title();
            retry++;
        }

        console.log(`📄 Page Title ล่าสุด: ${currentTitle}`);

        if (currentTitle.includes("Just a moment")) {
            throw new Error("Cloudflare Blocked: ไม่สามารถผ่านด่านตรวจได้");
        }

        await autoScroll(page);
        await new Promise(r => setTimeout(r, 1000));

        const chapters = await page.evaluate(() => {
            const list = [];
            // ใช้ Selector ที่กว้างขึ้นเพื่อให้ครอบคลุม
            const elements = document.querySelectorAll('a[href*="/content/"], a[href*="/chapter/"], .grid a');
            
            elements.forEach(el => {
                const href = el.href;
                const text = el.innerText.trim();
                // กรองเฉพาะลิงก์ที่น่าจะเป็นตอน (มีตัวเลข หรือคำว่า chapter)
                if (href && text && (/\d+/.test(text) || href.includes('chapter'))) {
                    list.push({ title: text.replace(/\s+/g, ' '), url: href });
                }
            });
            return list.filter((v, i, a) => a.findIndex(t => t.url === v.url) === i);
        });

        console.log(`✅ ดึงสำเร็จ: ${chapters.length} ตอน`);
        res.json({ success: true, chapters });

    } catch (err) {
        console.error("❌ Scraper Error:", err.message);
        res.status(500).json({ error: "ติดด่านป้องกันของเว็บต้นทาง", details: err.message });
    } finally {
        if (browser) await browser.close();
    }
});

app.get('/api/fetch-images', async (req, res) => {
    const { url } = req.query;
    if (!isWhitelisted(url)) return res.status(403).json({ error: "Access Denied" });

    let browser;
    try {
        browser = await puppeteer.launch(puppeteerOptions);
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
        
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await autoScroll(page);

        const images = await page.evaluate(() => {
            const imgs = document.querySelectorAll('.reading-content img, #readerarea img, .page-break img, .wp-manga-chapter-img');
            return Array.from(imgs).map(img => img.dataset.src || img.dataset.lazySrc || img.src)
                        .filter(src => src && src.startsWith('http'));
        });
        res.json({ success: true, images });
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        if (browser) await browser.close();
    }
});

// --- 8. Serving Frontend ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/:page', (req, res) => {
    const page = req.params.page;
    const forbidden = ['server.js', 'package.json', 'package-lock.json', '.env', 'Dockerfile'];
    if (forbidden.includes(page) || page.includes('..')) return res.status(403).send("Access Denied");
    if (page.includes('.')) return res.sendFile(path.join(__dirname, page));
    const filePath = path.join(__dirname, page + '.html');
    res.sendFile(filePath, (err) => {
        if (err) res.status(404).send("ไม่พบหน้านี้ (404)");
    });
});

// --- 9. Start Server ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server is running on port ${PORT}`);
});