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

// --- 6. API Routes (ระบบเดิมของคุณ) ---

app.get("/ping", (req, res) => res.status(200).send("OK"));

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
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

app.post("/add", auth, async (req, res) => {
    try {
        const mangaData = req.body;
        if (!mangaData.id) mangaData.id = Date.now().toString();
        const newManga = new Manga(mangaData);
        await newManga.save();
        res.json({ message: "เพิ่มสำเร็จ!" });
    } catch (err) { res.status(500).json({ message: "ไม่สามารถเพิ่มข้อมูลได้", error: err.message }); }
});

app.put('/api/manga/:id', auth, async (req, res) => {
    try {
        const { id } = req.params;
        const updatedData = req.body;
        let result = await Manga.findByIdAndUpdate(id, updatedData, { new: true }).catch(() => null);
        if (!result) result = await Manga.findOneAndUpdate({ id: id }, updatedData, { new: true });
        if (!result) return res.status(404).json({ message: "ไม่พบมังงะที่ต้องการแก้ไข" });
        res.status(200).json({ message: "อัปเดตเรียบร้อย!", data: result });
    } catch (err) { res.status(500).json({ message: "เกิดข้อผิดพลาดในการอัปเดต" }); }
});

app.delete("/delete/:id", auth, async (req, res) => {
    try {
        const { id } = req.params;
        let result = await Manga.findByIdAndDelete(id).catch(() => null);
        if (!result) result = await Manga.deleteOne({ id: id });
        if (result.deletedCount === 0 && !result._id) return res.status(404).json({ message: "ไม่พบข้อมูลที่ต้องการลบ" });
        res.json({ message: "ลบข้อมูลเรียบร้อยแล้ว!" });
    } catch (err) { res.status(500).json({ message: "เกิดข้อผิดพลาดในการลบ" }); }
});

app.post("/favorite", auth, async (req, res) => {
    const { username, mangaId } = req.body;
    const user = await User.findOne({ username });
    if (!user) return res.status(404).send("User not found");
    const index = user.favorites.indexOf(mangaId);
    if (index === -1) user.favorites.push(mangaId);
    else user.favorites.splice(index, 1);
    await user.save();
    res.json({ success: true, favorites: user.favorites });
});

// --- 7. API Routes (ระบบ Scraper ใหม่) ---
const chromePath = process.env.PUPPETEER_EXECUTABLE_PATH;
app.get('/api/fetch-chapters', async (req, res) => {
    const { url } = req.query;
    if (!isWhitelisted(url)) return res.status(403).json({ error: "Access Denied" });

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            // ไม่ต้องระบุ Path ตายตัว ให้ Puppeteer หาเอง หรือดึงจาก Env
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined, 
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--single-process'
            ]
        });
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

        const chapters = await page.evaluate(() => {
            const list = [];
            const selectors = ['.wp-manga-chapter a', '.chapter-link a', '#chapterlist a', '.num-a'];
            selectors.forEach(s => {
                document.querySelectorAll(s).forEach(el => {
                    list.push({ title: el.innerText.trim(), url: el.href });
                });
            });
            return list;
        });
        res.json({ success: true, chapters });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { if (browser) await browser.close(); }
});

app.get('/api/fetch-images', async (req, res) => {
    const { url } = req.query;
    if (!isWhitelisted(url)) return res.status(403).json({ error: "Access Denied" });

    let browser;
    try {
        browser = await puppeteer.launch({ headless: "new", args: ['--no-sandbox'] });
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

        const images = await page.evaluate(() => {
            const imgs = document.querySelectorAll('.reading-content img, #readerarea img, .page-break img');
            return Array.from(imgs).map(img => img.dataset.src || img.src).filter(src => src && src.startsWith('http'));
        });
        res.json({ success: true, images });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { if (browser) await browser.close(); }
});

// --- 8. Serving Frontend ---

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/:page', (req, res) => {
    const page = req.params.page;
    const forbiddenFiles = ['server.js', 'package.json', 'package-lock.json', '.env'];
    if (forbiddenFiles.includes(page) || page.includes('..')) return res.status(403).send("Access Denied");
    if (page.includes('.')) return res.sendFile(path.join(__dirname, page));
    
    const filePath = path.join(__dirname, page + '.html');
    res.sendFile(filePath, (err) => {
        if (err) res.status(404).send("ไม่พบหน้านี้ในระบบ (404 Not Found)");
    });
});

// --- 9. Start Server ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server is running on port ${PORT}`);
});