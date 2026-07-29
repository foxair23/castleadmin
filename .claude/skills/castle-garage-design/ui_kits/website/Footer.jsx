function Footer() {
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer-grid">
          <div className="footer-about">
            <div className="logo"><img src="../../assets/logo.png" alt="Castle Garage Doors & Gates" /></div>
            <p>Veteran-owned, family-run garage door and gate service company. Proudly serving San Diego to Riverside County since 1981.</p>
            <div className="footer-social">
              <a href="#" aria-label="Facebook"><svg viewBox="0 0 24 24"><path d="M18 2h-3a5 5 0 00-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 011-1h3z"/></svg></a>
              <a href="#" aria-label="Yelp"><svg viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg></a>
              <a href="#" aria-label="Google"><svg viewBox="0 0 24 24"><path d="M21.35 11.1h-9.18v2.73h5.51c-.24 1.27-.98 2.34-2.09 3.06v2.54h3.39c1.98-1.82 3.12-4.51 3.12-7.58 0-.52-.05-1.02-.13-1.5z" fill="#4285F4"/><path d="M12.17 22c2.84 0 5.22-.94 6.96-2.57l-3.39-2.54c-.94.63-2.15 1-3.57 1-2.74 0-5.06-1.85-5.89-4.34H2.76v2.62A10.5 10.5 0 0012.17 22z" fill="#34A853"/><path d="M6.28 13.55a6.3 6.3 0 010-4.1V6.83H2.76a10.5 10.5 0 000 9.34l3.52-2.62z" fill="#FBBC05"/><path d="M12.17 5.11c1.55 0 2.94.53 4.03 1.58l3.02-3.02C17.38 1.89 14.99.89 12.17.89A10.5 10.5 0 002.76 6.83l3.52 2.62c.83-2.49 3.15-4.34 5.89-4.34z" fill="#EA4335"/></svg></a>
            </div>
          </div>
          <div>
            <h4>Services</h4>
            <div className="footer-links">
              <a href="#">Garage Door Repair</a>
              <a href="#">New Garage Doors</a>
              <a href="#">Garage Door Openers</a>
              <a href="#">Gate Services</a>
              <a href="#">Emergency Repair</a>
            </div>
          </div>
          <div>
            <h4>Service Areas</h4>
            <div className="footer-links">
              <a href="#">San Diego</a>
              <a href="#">Escondido</a>
              <a href="#">Oceanside</a>
              <a href="#">Carlsbad</a>
              <a href="#">Temecula</a>
              <a href="#">Corona</a>
            </div>
          </div>
          <div>
            <h4>Contact</h4>
            <div className="footer-links">
              <a href="tel:8005761397">(800) 576-1397</a>
              <a href="mailto:info@castlegaragedoors.com">info@castlegaragedoors.com</a>
              <span style={{fontSize: 'var(--text-small)', lineHeight: 1.4}}>1291 Simpson Way Suite D<br/>Escondido, CA 92029</span>
            </div>
            <a href="#" className="btn btn-primary btn-sm" style={{marginTop: 16, width: '100%', textAlign: 'center'}}>Schedule Service</a>
          </div>
        </div>
        <div className="footer-bottom">
          <p>© 2026 Castle Garage Inc. All rights reserved. | <a href="#">Privacy</a> | <a href="#">Terms</a></p>
          <div className="footer-badges">
            <span className="footer-badge">Home Depot Authorized</span>
            <span className="footer-badge">Clopay Dealer</span>
            <span className="footer-badge">BBB A+</span>
            <span className="footer-badge">Veteran-Owned</span>
            <span className="footer-badge">CSLB #1154002 (C-61/D-28)</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
window.Footer = Footer;
