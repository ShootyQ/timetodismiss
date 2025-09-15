const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API Routes for dismissal management
app.get('/api/dismissals', (req, res) => {
    // TODO: Implement database integration
    res.json([]);
});

app.post('/api/dismissals', (req, res) => {
    // TODO: Implement dismissal creation
    res.json({ success: true, message: 'Dismissal recorded' });
});

// Start server
app.listen(PORT, () => {
    console.log(`TimeToDisMiss server running on port ${PORT}`);
    console.log(`Visit http://localhost:${PORT} to access the platform`);
});