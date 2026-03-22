require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const app = express();

app.use(cors());
app.use(express.json());

// --- 1. เชื่อมต่อ MongoDB Atlas ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ Connected to MongoDB"))
    .catch(err => console.error("❌ MongoDB Error:", err));

// --- 2. Database Schemas ---
const Manga = mongoose.model('Manga', new mongoose.Schema({
    id: String, title: String, cover: String, description: String, tags: [String],
    rating: String, jp_name: String, en_name: String, th_name: String,
    author: String, artist: String, translator: String, translator_link: String,
    thai_url: String, original_url: String, updated_at: String
}));

const User = mongoose.model('User', new mongoose.Schema({
    username: { type: String, unique: true },
    password: { type: String },
    favorites: [String]
}));

// --- 3. Auth Middleware ---
const auth = (req, res, next) => {
    // เช็คกุญแจใน Header 'Authorization'
    if (req.headers['authorization'] === process.env.SECRET_TOKEN) next();
    else res.status(403).json({ message: "Forbidden: กุญแจไม่ถูกต้อง" });
};

// --- 4. API Routes (ส่วนควบคุมข้อมูล) ---

// Login
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

// ดึงมังงะทั้งหมด
app.get("/manga", async (req, res) => {
    const mangas = await Manga.find().sort({ _id: -1 }); 
    res.json(mangas);
});

// ดึงข้อมูลมังงะรายเรื่อง (ใช้ตอนโหลดหน้าแก้ไข)
app.get("/api/manga/:id", async (req, res) => {
    try {
        const { id } = req.params;
        // พยายามหาจาก _id ก่อน ถ้าไม่เจอหาจาก id String
        let manga = await Manga.findById(id).catch(() => null);
        if (!manga) manga = await Manga.findOne({ id: id });
        
        if (!manga) return res.status(404).json({ message: "ไม่พบมังงะ" });
        res.json(manga);
    } catch (err) {
        res.status(500).json({ message: "Error fetching manga" });
    }
});

// เพิ่มมังงะใหม่
app.post("/add", auth, async (req, res) => {
    const newManga = new Manga(req.body);
    await newManga.save();
    res.json({ message: "เพิ่มสำเร็จ!" });
});

// แก้ไขข้อมูลมังงะ
app.put('/api/manga/:id', auth, async (req, res) => {
    try {
        const { id } = req.params;
        const updatedData = req.body;
        
        // อัปเดตข้อมูล (รองรับทั้ง _id และ id)
        let result = await Manga.findByIdAndUpdate(id, updatedData, { new: true }).catch(() => null);
        if (!result) {
            result = await Manga.findOneAndUpdate({ id: id }, updatedData, { new: true });
        }
        
        if (!result) return res.status(404).json({ message: "ไม่พบมังงะที่ต้องการแก้ไข" });
        res.status(200).json({ message: "อัปเดตเรียบร้อย!", data: result });
    } catch (err) {
        res.status(500).json({ message: "เกิดข้อผิดพลาดในการอัปเดต" });
    }
});

// ลบมังงะ
app.delete("/delete/:id", auth, async (req, res) => {
    // ลบโดยเช็คทั้ง id และ _id
    let result = await Manga.findByIdAndDelete(req.params.id).catch(() => null);
    if (!result) {
        result = await Manga.deleteOne({ id: req.params.id });
    }
    res.json({ message: "ลบแล้ว!" });
});

// ระบบ Favorite
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

// --- 5. Serving Frontend (จัดการหน้าเว็บ) ---

// บอกให้ Express รู้จักไฟล์ HTML, CSS, JS
app.use(express.static(__dirname));

// เมื่อเข้าหน้าแรก
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ดักจับหน้า .html อื่นๆ (ต้องอยู่ล่างสุดของ API)
app.get('/:page', (req, res) => {
    // ป้องกันไม่ให้ไปดึงไฟล์ที่ไม่มีอยู่จริงจนเกิด Error
    if (req.params.page.includes('.')) {
        res.sendFile(path.join(__dirname, req.params.page));
    } else {
        res.status(404).send("Page not found");
    }
});

// --- 6. Start Server ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server is running on port ${PORT}`);
});