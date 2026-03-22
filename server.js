require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path'); // เพิ่ม path เพื่อจัดการตำแหน่งไฟล์
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
    if (req.headers['authorization'] === process.env.SECRET_TOKEN) next();
    else res.status(403).json({ message: "Forbidden: กุญแจไม่ถูกต้อง" });
};

// --- 4. API Routes ---

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

app.get("/manga", async (req, res) => {
    res.json(await Manga.find());
});

app.post("/add", auth, async (req, res) => {
    const newManga = new Manga(req.body);
    await newManga.save();
    res.json({ message: "เพิ่มสำเร็จ!" });
});

app.delete("/delete/:id", auth, async (req, res) => {
    await Manga.deleteOne({ id: req.params.id });
    res.json({ message: "ลบแล้ว!" });
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

// --- 5. Serving Frontend (แก้ปัญหาหน้าขาว) ---

// บอกให้ Express รู้จักไฟล์ HTML, CSS, JS ในโฟลเดอร์ปัจจุบัน
app.use(express.static(__dirname));

// เมื่อเข้าหน้าแรก (/) ให้ส่งไฟล์ index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ดักจับการเรียกหน้า .html อื่นๆ (เช่น /admin.html)
app.get('/:page', (req, res) => {
    res.sendFile(path.join(__dirname, req.params.page));
});

// --- 6. Start Server ---
const PORT = process.env.PORT || 10000; // ใช้ Port 10000 ตามที่ Render กำหนด
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server is running on port ${PORT}`);
});

// แก้ไขเนื้อหาเรื่งอนั้นๆที่เพิ่มไปแล้ว
app.put('/api/manga/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const updatedData = req.body;
        
        // อัปเดตข้อมูลใน MongoDB โดยใช้ ID
        const result = await Manga.findByIdAndUpdate(id, updatedData, { new: true });
        
        if (!result) return res.status(404).json({ message: "ไม่พบมังงะเรื่องนี้" });
        res.status(200).json({ message: "อัปเดตเรียบร้อย!", data: result });
    } catch (err) {
        res.status(500).json({ message: "เกิดข้อผิดพลาดในการอัปเดต" });
    }
});