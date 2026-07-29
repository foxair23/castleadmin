function ServicePillars() {
  return (
    <section className="section">
      <div className="container">
        <div className="section-header">
          <span className="section-label">Our Services</span>
          <h2>Expert Garage Door <span style={{color: 'var(--color-red)'}}>&amp;</span> Gate Solutions</h2>
          <p>From emergency repairs to brand-new installations, we handle it all with over four decades of experience.</p>
        </div>
        <div className="services-pillars">
          <div className="service-pillar fade-up visible">
            <div className="pillar-img"><img src="../../assets/photos/pillars/garage-doors.png" alt="Modern glass garage door installed by Castle in San Diego" /></div>
            <h3>Garage Doors</h3>
            <p>Repair, installation, and opener service for residential and commercial garage doors. Clopay Authorized Dealer with LiftMaster &amp; Genie openers.</p>
            <a href="#" className="btn btn-primary btn-sm">Explore Garage Door Services →</a>
          </div>
          <div className="service-pillar fade-up visible">
            <div className="pillar-img"><img src="../../assets/photos/pillars/gates.png" alt="Custom wood-and-iron driveway gate by Castle in San Diego County" /></div>
            <h3>Gates</h3>
            <p>Automatic, driveway, security, and wrought iron gates. Installation, repair, and opener service — a specialty most competitors don't offer.</p>
            <a href="#" className="btn btn-primary btn-sm">Explore Gate Services →</a>
          </div>
        </div>
      </div>
    </section>
  );
}
window.ServicePillars = ServicePillars;
