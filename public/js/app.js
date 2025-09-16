// TimeToDisMiss - JavaScript Application
class DismissalManager {
    constructor() {
        this.dismissals = [];
        this.init();
    }

    init() {
        this.bindEvents();
        this.loadDismissals();
        this.updateStats();
    }

    bindEvents() {
        const form = document.getElementById('dismissalForm');
        if (form) {
            form.addEventListener('submit', (e) => this.handleSubmit(e));
        }
    }

    handleSubmit(e) {
        e.preventDefault();
        
        const formData = new FormData(e.target);
        const dismissalData = {
            id: Date.now(),
            studentName: formData.get('studentName'),
            studentId: formData.get('studentId'),
            grade: formData.get('grade'),
            dismissalType: formData.get('dismissalType'),
            parentName: formData.get('parentName'),
            timestamp: new Date().toISOString(),
            status: 'pending'
        };

        this.addDismissal(dismissalData);
        this.showMessage('Dismissal recorded successfully!', 'success');
        e.target.reset();
    }

    addDismissal(dismissalData) {
        this.dismissals.push(dismissalData);
        this.saveDismissals();
        this.renderDismissals();
        this.updateStats();
    }

    loadDismissals() {
        const saved = localStorage.getItem('dismissals');
        if (saved) {
            this.dismissals = JSON.parse(saved);
            this.renderDismissals();
        }
    }

    saveDismissals() {
        localStorage.setItem('dismissals', JSON.stringify(this.dismissals));
    }

    renderDismissals() {
        const container = document.getElementById('dismissalList');
        if (!container) return;

        if (this.dismissals.length === 0) {
            container.innerHTML = '<p class="no-dismissals">No dismissals recorded yet today.</p>';
            return;
        }

        const today = new Date().toDateString();
        const todayDismissals = this.dismissals.filter(d => 
            new Date(d.timestamp).toDateString() === today
        );

        if (todayDismissals.length === 0) {
            container.innerHTML = '<p class="no-dismissals">No dismissals recorded yet today.</p>';
            return;
        }

        const html = todayDismissals
            .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
            .map(dismissal => this.createDismissalHTML(dismissal))
            .join('');

        container.innerHTML = html;
    }

    createDismissalHTML(dismissal) {
        const time = new Date(dismissal.timestamp).toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit'
        });

        return `
            <div class="dismissal-item">
                <div class="dismissal-header">
                    ${dismissal.studentName} (ID: ${dismissal.studentId})
                    <span class="dismissal-time">${time}</span>
                </div>
                <div class="dismissal-details">
                    Grade: ${dismissal.grade} | Type: ${this.formatDismissalType(dismissal.dismissalType)}
                    ${dismissal.parentName ? ` | Parent: ${dismissal.parentName}` : ''}
                </div>
            </div>
        `;
    }

    formatDismissalType(type) {
        const types = {
            'parent': 'Parent Pickup',
            'bus': 'Bus',
            'aftercare': 'After Care',
            'walker': 'Walker'
        };
        return types[type] || type;
    }

    updateStats() {
        const today = new Date().toDateString();
        const todayDismissals = this.dismissals.filter(d => 
            new Date(d.timestamp).toDateString() === today
        );

        const totalElement = document.getElementById('totalDismissals');
        const pendingElement = document.getElementById('pendingDismissals');

        if (totalElement) {
            totalElement.textContent = todayDismissals.length;
        }

        if (pendingElement) {
            const pending = todayDismissals.filter(d => d.status === 'pending').length;
            pendingElement.textContent = pending;
        }
    }

    showMessage(text, type = 'success') {
        const existing = document.querySelector('.message');
        if (existing) {
            existing.remove();
        }

        const message = document.createElement('div');
        message.className = `message ${type}`;
        message.textContent = text;

        const form = document.getElementById('dismissalForm');
        if (form) {
            form.parentNode.insertBefore(message, form);
            
            setTimeout(() => {
                message.remove();
            }, 5000);
        }
    }

    // Utility method to clear all dismissals (for testing)
    clearAllDismissals() {
        this.dismissals = [];
        this.saveDismissals();
        this.renderDismissals();
        this.updateStats();
        this.showMessage('All dismissals cleared!', 'success');
    }

    // Export dismissals data
    exportDismissals() {
        const data = JSON.stringify(this.dismissals, null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = `dismissals-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
}

// Initialize the application when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.dismissalManager = new DismissalManager();
    
    // Add some demo functionality for development
    if (window.location.hostname === 'localhost') {
        console.log('TimeToDisMiss Debug Mode');
        console.log('Available commands:');
        console.log('- dismissalManager.clearAllDismissals() - Clear all data');
        console.log('- dismissalManager.exportDismissals() - Export data as JSON');
    }
});

// Service Worker registration for offline capability (future enhancement)
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        // TODO: Implement service worker for offline functionality
    });
}