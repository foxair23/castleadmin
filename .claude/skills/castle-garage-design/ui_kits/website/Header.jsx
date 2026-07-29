/* global React */
const { useState } = React;

function Header() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <header className="header">
        <div className="header-inner">
          <a href="#" className="logo">
            <img src="../../assets/logo.png" alt="Castle Garage Doors & Gates" />
          </a>
          <nav className="nav-desktop">
            <div className="nav-dropdown">
              <a href="#services">Services <span className="nav-arrow">▾</span></a>
              <div className="mega-menu">
                <a href="#">Garage Door Repair</a>
                <a href="#">New Garage Doors</a>
                <a href="#">Garage Door Openers</a>
                <a href="#">Gate Installation & Repair</a>
                <a href="#">Emergency Repair</a>
                <a href="#" className="mega-menu-viewall">View All Services →</a>
              </div>
            </div>
            <a href="#">Service Areas</a>
            <a href="#">About</a>
            <a href="#">Reviews</a>
            <a href="#">Gallery</a>
            <a href="#">Blog</a>
            <a href="#">Contact</a>
          </nav>
          <div className="header-right">
            <div className="header-phone">
              <a href="tel:8005761397">
                <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6.62 10.79a15 15 0 006.59 6.59l2.2-2.2a1 1 0 011.01-.24c1.12.37 2.33.57 3.58.57a1 1 0 011 1V20a1 1 0 01-1 1A17 17 0 013 4a1 1 0 011-1h3.5a1 1 0 011 1c0 1.25.2 2.46.57 3.58a1 1 0 01-.24 1.01l-2.21 2.2z"/></svg>
                <span className="phone-text">(800) 576-1397</span>
              </a>
            </div>
            <a href="#" className="btn btn-primary btn-sm header-schedule">Schedule Service</a>
            <button className={`hamburger ${open ? 'open' : ''}`} onClick={() => setOpen(!open)} aria-label="Open menu">
              <span></span><span></span><span></span>
            </button>
          </div>
        </div>
      </header>
      <nav className={`mobile-menu ${open ? 'open' : ''}`}>
        <a href="#">Services</a>
        <a href="#">Service Areas</a>
        <a href="#">About</a>
        <a href="#">Reviews</a>
        <a href="#">Gallery</a>
        <a href="#">Blog</a>
        <a href="#">Contact</a>
        <a href="#" className="btn btn-primary">Schedule Service</a>
      </nav>
    </>
  );
}

window.Header = Header;
