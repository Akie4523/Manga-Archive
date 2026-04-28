require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');

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

// --- 4. GAS Config ---
// URL ของ Google Apps Script ที่คุณให้มา
const GAS_URL = "https://script.google.com/macros/s/AKfycbxlIEynv1arhgGRxg4t2VgxZ9zvpzJEuStUWHPHrE4m9qiWhuA8Kx4hC37I2oFh4dL7/exec";

const isWhitelisted = (url) => {
    try {
        const domain = new URL(url).hostname;
        const allowed = ['fluxtoon.com', 'mangaisekaithai.net', 'facebook.com', 'nekopost.net'];
        return allowed.some(d => domain.includes(d));
    } catch (e) { return false; }
};

// --- 5. API Routes (ข้อมูลทั่วไป) ---
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
        const updatedManga = await Manga.findOneAndUpdate({ id: id }, updateData, { new: true });
        if (!updatedManga) return res.status(404).json({ message: "ไม่พบมังงะที่ต้องการแก้ไข" });
        res.json({ success: true, manga: updatedManga });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 6. API Routes (Scraper using GAS Proxy) ---

app.get('/api/fetch-chapters', async (req, res) => {
    const { url } = req.query;
    if (!isWhitelisted(url)) return res.status(403).json({ error: "Access Denied" });

    try {
        console.log(`📡 Fetching via GAS: ${url}`);
        
        const response = await axios.get(GAS_URL, {
            params: { url: url },
            timeout: 30000,
            maxRedirects: 5
        });

        const html = response.data;

        // เช็คว่า GAS ส่ง Error กลับมาเป็น String หรือเปล่า
        if (typeof html !== 'string' || html.startsWith("Error:")) {
            console.error("⚠️ GAS Side Error:", html);
            return res.json({ success: false, targetUrl: url, message: html });
        }

        const $ = cheerio.load(html);
        const chapters = [];

        // ปรับ Selector ให้เจาะจงสำหรับ Fluxtoon มากขึ้น
        // ปกติ Fluxtoon จะใช้ .wp-manga-chapter หรือระบุเจาะจงใน list-group
        $('.wp-manga-chapter a, .listing-chapters_wrap a').each((i, el) => {
            const href = $(el).attr('href');
            const text = $(el).text().trim();
            if (href && text && /\d+/.test(text)) {
                chapters.push({ title: text, url: href });
            }
        });

        if (chapters.length === 0) {
            // ลองใช้ Selector สำรองถ้าหาไม่เจอ
            $('a').each((i, el) => {
                const href = $(el).attr('href') || "";
                const text = $(el).text().trim();
                if (href.includes('/chapter-') || href.includes('/ตอนที่-')) {
                   chapters.push({ title: text || href.split('/').pop(), url: href });
                }
            });
        }

        const uniqueChapters = chapters.filter((v, i, a) => a.findIndex(t => t.url === v.url) === i);
        console.log(`✅ ดึงสำเร็จ: ${uniqueChapters.length} ตอน`);
        res.json({ success: true, chapters: uniqueChapters });

    } catch (err) {
        console.error("❌ Node Server Error:", err.message);
        res.json({ success: false, targetUrl: url });
    }
});

app.get('/api/fetch-images', async (req, res) => {
    const { url } = req.query;
    if (!isWhitelisted(url)) return res.status(403).json({ error: "Access Denied" });

    try {
        console.log(`📡 Fetching Images via GAS: ${url}`);
        const response = await axios.get(`${GAS_URL}?url=${encodeURIComponent(url)}`);
        const html = response.data;

        const $ = cheerio.load(html);
        const images = [];

        // ค้นหารูปภาพจาก Selector ทั่วไปของเว็บมังงะ
        $('.reading-content img, #readerarea img, .page-break img, .wp-manga-chapter-img').each((i, el) => {
            const src = $(el).attr('data-src') || $(el).attr('data-lazy-src') || $(el).attr('src');
            if (src && src.startsWith('http')) {
                images.push(src.trim());
            }
        });

        console.log(`✅ ดึงรูปสำเร็จ: ${images.length} รูป`);
        res.json({ success: true, images });
    } catch (err) {
        console.error("❌ Image Fetch Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/fetch-chapters', async (req, res) => {
    const { url } = req.query;
    // ไม่ต้องฝืนดึงแล้ว ส่ง success: false ไปเลยเพื่อให้ Frontend จัดการต่อ
    console.log(`⚠️ Redirecting user to source: ${url}`);
    res.json({ 
        success: false, 
        targetUrl: url, 
        message: "Cloudflare ของเว็บต้นทางเข้มงวดเกินไป ระบบจะพาคุณไปอ่านที่หน้าเว็บหลัก" 
    });
});

// --- 7. Serving Frontend ---
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

// --- 8. Start Server ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server is running on port ${PORT}`);
});

/--Discord Bot--/

const { Client, GatewayIntentBits, PermissionFlagsBits } = require('discord.js');

// --- ตั้งค่าบอท ---
const TOKEN = process.env.DISCORD_TOKEN;
const MY_OWNER_ID = '767330467329343528';
const TRAP_CHANNELS = ['1498735590596804721', '1498741392770465864'];

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

client.once('ready', () => {
    console.log(`✅ บอท ${client.user.tag} ออนไลน์พร้อมกับเว็บแล้ว!`);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    // Bypass ให้ตัวเอง
    if (message.author.id === MY_OWNER_ID) return;

    // เช็คห้องกับดัก
    if (TRAP_CHANNELS.includes(message.channel.id)) {
        try {
            // 1. ลงโทษ Timeout 24 ชม.
            const member = await message.guild.members.fetch(message.author.id);
            await member.timeout(24 * 60 * 60 * 1000, 'Security Trigger: Honey Pot');

            // 2. ลบข้อความ
            await message.delete();

            // 3. ส่ง DM แจ้งเตือน (ข้อความที่คุณต้องการ)
            try {
                await message.author.send(
                    `**แจ้งเตือนจากเซิร์ฟเวอร์ ${message.guild.name}**\n\n` +
                    `บัญชีของคุณถูก Timeout เป็นเวลา 24 ชั่วโมง เนื่องจากมีการพิมพ์ในห้อง ${message.channel.name}\n` +
                    `ระบบได้ทำการลบข้อความของคุณเพื่อความปลอดภัย หากคุณไม่ได้เป็นคนพิมพ์ โปรดตรวจสอบไอดีของคุณโดยด่วน`
                );
            } catch (dmErr) {
                console.log(`❌ ไม่สามารถส่ง DM ให้ ${message.author.tag} ได้ (อาจปิด DM ส่วนตัว)`);
            }

            console.log(`⚡ จัดการลบข้อความและ Timeout: ${message.author.tag} เรียบร้อย`);
        } catch (err) {
            console.error('⚠️ เกิดข้อผิดพลาดในการจัดการห้องกับดัก:', err);
        }
    }
});