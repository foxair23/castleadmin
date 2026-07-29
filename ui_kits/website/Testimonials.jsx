const TESTIMONIALS = [
  { quote: "Castle replaced both springs and rollers on our garage door. The technician was on time, professional, and explained everything before starting. Fair pricing and excellent work. Highly recommend!", author: "Jennifer M.", source: "Escondido, CA · Spring & Roller Replacement · via Yelp" },
  { quote: "We had an emergency on a Saturday morning — our garage door cable snapped and the door was stuck. Castle came out within two hours and had everything fixed. Lifesavers!", author: "Robert & Maria T.", source: "Temecula, CA · Emergency Cable Repair · via Google" },
  { quote: "Veteran-owned and it shows in their work ethic. On time, professional, no BS. They diagnosed the problem quickly and fixed it at a fair price. Exactly what you want in a service company.", author: "Lt. Col. Dan R. (Ret.)", source: "Fallbrook, CA · Opener Repair · via Yelp" },
];

function Testimonials() {
  return (
    <section className="section">
      <div className="container">
        <div className="section-header">
          <span className="section-label">Customer Reviews</span>
          <h2>What Our Customers Say</h2>
          <p>Rated 4.4 stars across 210+ reviews on Google and Yelp.</p>
        </div>
        <div className="testimonials-grid">
          {TESTIMONIALS.map((t, i) => (
            <div className="testimonial-card fade-up visible" key={i}>
              <div className="testimonial-stars">★★★★★</div>
              <blockquote>"{t.quote}"</blockquote>
              <div className="testimonial-author">{t.author}</div>
              <div className="testimonial-source">{t.source}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
window.Testimonials = Testimonials;
