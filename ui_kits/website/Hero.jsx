function Hero() {
  return (
    <section className="hero page-top">
      <div className="hero-bg" style={{backgroundImage: "url('../../assets/photos/hero/home-hero.png')"}}></div>
      <div className="hero-overlay"></div>
      <div className="hero-content container">
        <div className="hero-heritage">FAMILY-OWNED &amp; OPERATED · SINCE 1981</div>
        <h1>Garage Door <span style={{color: 'var(--color-red)'}}>&amp;</span> Gate Repair</h1>
        <p className="hero-subtitle" style={{fontSize: '1.375rem', fontStyle: 'italic', opacity: 0.95, marginBottom: 'var(--space-2)'}}>San Diego's Knight at the Gate</p>
        <p>Expert repair, installation, and maintenance from San Diego to Riverside County. Licensed, bonded, and insured — CSLB #1154002.</p>
        <div className="hero-buttons">
          <a href="#" className="btn btn-primary">Schedule Service</a>
          <a href="tel:8005761397" className="btn btn-outline-white">Call (800) 576-1397</a>
        </div>
        <div className="hero-trust">
          <div className="hero-trust-item"><svg viewBox="0 0 24 24"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z"/></svg> 45+ Years Experience</div>
          <div className="hero-trust-item"><svg viewBox="0 0 24 24"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm.5 5H11v6l5.25 3.15.75-1.23-4.5-2.67V7z"/></svg> 24/7 Emergency Service</div>
          <div className="hero-trust-item"><svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg> Free Estimates</div>
        </div>
      </div>
    </section>
  );
}
window.Hero = Hero;
