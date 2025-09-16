# TimeToDisMiss

**Dismissal Platform for Schools**

A comprehensive web-based platform designed to streamline and manage student dismissal processes in elementary schools. TimeToDisMiss helps school staff efficiently track student pickups, manage dismissal queues, and ensure safe and organized student departure.

## Features

- **Student Dismissal Management**: Record and track student dismissals with detailed information
- **Multiple Dismissal Types**: Support for parent pickup, bus, after care, and walker dismissals
- **Real-time Dashboard**: Live view of today's dismissals and statistics
- **Responsive Design**: Works seamlessly on desktop, tablet, and mobile devices
- **Local Data Storage**: Browser-based storage for quick access and offline capability

## Getting Started

### Prerequisites

- Node.js (version 14 or higher)
- npm (Node Package Manager)

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/ShootyQ/timetodismiss.git
   cd timetodismiss
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the server:
   ```bash
   npm start
   ```

4. Open your browser and navigate to:
   ```
   http://localhost:3000
   ```

## Usage

### Recording a Dismissal

1. Fill out the student dismissal form with:
   - Student Name
   - Student ID
   - Grade Level
   - Dismissal Type (Parent Pickup, Bus, After Care, Walker)
   - Parent/Guardian Name (if applicable)

2. Click "Record Dismissal" to save the information

3. View the dismissal in the "Today's Dismissals" section

### Dashboard Features

- **Today's Dismissals**: View all dismissals recorded for the current day
- **Quick Stats**: See total dismissals and pending dismissals at a glance
- **Real-time Updates**: Dashboard updates automatically as new dismissals are recorded

## Project Structure

```
timetodismiss/
├── public/
│   ├── css/
│   │   └── style.css          # Application styling
│   ├── js/
│   │   └── app.js             # Client-side JavaScript
│   └── index.html             # Main application interface
├── server.js                  # Express.js server
├── package.json               # Project dependencies
├── .gitignore                 # Git ignore rules
└── README.md                  # Project documentation
```

## Technology Stack

- **Frontend**: HTML5, CSS3, Vanilla JavaScript
- **Backend**: Node.js with Express.js
- **Data Storage**: Browser LocalStorage (temporary solution)
- **Styling**: Custom CSS with responsive design

## Development

### Running in Development Mode

```bash
npm run dev
```

### Future Enhancements

- Database integration (MongoDB/PostgreSQL)
- User authentication and authorization
- Print functionality for dismissal reports
- SMS/Email notifications for parents
- Barcode/QR code scanning for student IDs
- Integration with school information systems
- Multi-school support
- Advanced reporting and analytics

## API Endpoints

- `GET /` - Main application interface
- `GET /api/dismissals` - Retrieve dismissals (future implementation)
- `POST /api/dismissals` - Create new dismissal (future implementation)

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/new-feature`)
3. Commit your changes (`git commit -am 'Add new feature'`)
4. Push to the branch (`git push origin feature/new-feature`)
5. Create a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Support

For support, questions, or feature requests, please create an issue in the GitHub repository.

---

**TimeToDisMiss** - Making school dismissals safer and more efficient.
