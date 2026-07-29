const WHY_ITEMS = [
  { icon: <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z"/>, title: "40+ Years of Experience", body: "Serving San Diego and Riverside County since 1981. Castle technicians average 15+ years of experience." },
  { icon: <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>, title: "Veteran-Owned & Operated", body: "Military values of discipline, integrity, and service excellence at the core of everything we do." },
  { icon: <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/>, title: "Authorized Home Depot Provider", body: "Trusted to serve 28 Home Depot stores as an authorized service provider — San Diego to Corona." },
  { icon: <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/>, title: "Licensed, Bonded & Insured", body: "CSLB License #1154002, C-61/D-28. Full liability coverage. Weekly OSHA safety training." },
];

function WhyCastle() {
  return (
    <section className="section section-white">
      <div className="container">
        <div className="section-header">
          <span className="section-label">Why Castle</span>
          <h2>Why Homeowners Trust Castle</h2>
          <p>We've built our reputation one garage door at a time over more than four decades.</p>
        </div>
        <div className="why-grid">
          {WHY_ITEMS.map((w, i) => (
            <div className="why-item fade-up visible" key={i}>
              <div className="why-icon"><svg viewBox="0 0 24 24">{w.icon}</svg></div>
              <div>
                <h3>{w.title}</h3>
                <p>{w.body}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
window.WhyCastle = WhyCastle;
