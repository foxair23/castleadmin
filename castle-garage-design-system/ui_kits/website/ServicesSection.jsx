const SERVICES = [
  { icon: <path d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z"/>, title: "Garage Door Repair", body: "Springs, cables, rollers, panels, tracks, sensors. Same-day and 24/7 emergency service.", cta: "Schedule Repair" },
  { icon: <path d="M12 3C6.95 3 3.15 4.85 0 7.23L12 22 24 7.25C20.85 4.87 17.05 3 12 3z"/>, title: "Openers", body: "LiftMaster, Marantec, Genie. Smart/WiFi, belt drive, chain drive, wall-mount.", cta: "Explore Options" },
  { icon: <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm.5 5H11v6l5.25 3.15.75-1.23-4.5-2.67V7z"/>, title: "Emergency Repair", body: "24/7 emergency service. Stuck door? Broken spring? Call any time.", cta: "Get Help Now" },
];

function ServicesSection() {
  return (
    <section className="section" id="services">
      <div className="container">
        <div className="section-header">
          <span className="section-label">Our Services</span>
          <h2>Expert Garage Door <span style={{color: 'var(--color-red)'}}>&amp;</span> Gate Solutions</h2>
          <p>From emergency repairs to brand-new installations, we handle it all with over four decades of experience.</p>
        </div>
        <div className="services-grid">
          {SERVICES.map((s, i) => (
            <div className="service-card fade-up visible" key={i}>
              <div className="service-icon"><svg viewBox="0 0 24 24">{s.icon}</svg></div>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
              <a href="#" className="link">{s.cta} →</a>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
window.ServicesSection = ServicesSection;
