require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
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

// Login: ระบบปิด (เช็คชื่ออย่างเดียว ไม่มีการสร้างใหม่)
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    
    // แก้: ถ้าไม่เจอ User หรือรหัสผิด ให้ Error ทันที (ห้าม new User เอง)
    if (!user || user.password !== password) {
        return res.status(401).json({ success: false, message: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง (เฉพาะผู้ได้รับอนุญาตเท่านั้น)" });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server on port ${PORT}`));