/* @ds-bundle: {"format":3,"namespace":"CastleGarageDesignSystem_019e0e","components":[],"sourceHashes":{"script.js":"992a4c4554b4","ui_kits/website/CTABanner.jsx":"85456ac83f05","ui_kits/website/Footer.jsx":"13f519286b3f","ui_kits/website/Header.jsx":"4acf91471414","ui_kits/website/Hero.jsx":"a382e39d297b","ui_kits/website/ServicePillars.jsx":"e62c23226eeb","ui_kits/website/ServicesSection.jsx":"125fbf804ce7","ui_kits/website/Testimonials.jsx":"22c0da02063f","ui_kits/website/TrustStrip.jsx":"60415a215f39","ui_kits/website/WhyCastle.jsx":"8caba988722c"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.CastleGarageDesignSystem_019e0e = window.CastleGarageDesignSystem_019e0e || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// script.js
try { (() => {
/* ===================================================================
   Castle Garage Doors & Gates — Shared JavaScript
   =================================================================== */

(function () {
  'use strict';

  // ===== FLOATING CTA (fades in after scroll) =====
  var header = document.getElementById('header');
  var floatingCta = document.getElementById('floatingCta');
  if (floatingCta) {
    window.addEventListener('scroll', function () {
      floatingCta.style.opacity = window.scrollY > 80 ? '1' : '0';
    }, {
      passive: true
    });
  }

  // ===== MOBILE MENU =====
  var hamburger = document.getElementById('hamburger');
  var mobileMenu = document.getElementById('mobileMenu');
  if (hamburger && mobileMenu) {
    hamburger.addEventListener('click', function () {
      var isOpen = mobileMenu.classList.toggle('open');
      hamburger.classList.toggle('open');
      hamburger.setAttribute('aria-expanded', isOpen);
      document.body.style.overflow = isOpen ? 'hidden' : '';
    });
  }
  // Close mobile menu on link click
  window.closeMobileMenu = function () {
    if (mobileMenu) mobileMenu.classList.remove('open');
    if (hamburger) {
      hamburger.classList.remove('open');
      hamburger.setAttribute('aria-expanded', 'false');
    }
    document.body.style.overflow = '';
  };
  document.querySelectorAll('.mobile-menu a').forEach(function (a) {
    a.addEventListener('click', window.closeMobileMenu);
  });

  // ===== SCROLL REVEAL =====
  if ('IntersectionObserver' in window) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      });
    }, {
      threshold: 0.1
    });
    document.querySelectorAll('.fade-up').forEach(function (el) {
      observer.observe(el);
    });
  }

  // ===== FORM HANDLING =====
  var form = document.getElementById('contactForm');
  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      // TODO: Replace with ServiceTitan booking widget integration
      alert('Thank you! We received your request and will contact you shortly.\nFor immediate assistance, call (800) 576-1397.');
      form.reset();
    });
  }

  // ===== GALLERY FILTERS =====
  var galleryFilters = document.querySelectorAll('.gallery-filters button');
  if (galleryFilters.length) {
    galleryFilters.forEach(function (btn) {
      btn.addEventListener('click', function () {
        galleryFilters.forEach(function (b) {
          b.classList.remove('active');
        });
        btn.classList.add('active');
        var filter = btn.getAttribute('data-filter');
        document.querySelectorAll('.gallery-item').forEach(function (item) {
          if (filter === 'all' || item.getAttribute('data-category') === filter) {
            item.style.display = '';
          } else {
            item.style.display = 'none';
          }
        });
      });
    });
  }

  // ===== GA4 EVENT TRACKING =====
  function trackEvent(name, params) {
    if (typeof gtag === 'function') {
      gtag('event', name, params);
    }
  }
  // Phone clicks
  document.querySelectorAll('a[href^="tel:"]').forEach(function (link) {
    link.addEventListener('click', function () {
      trackEvent('phone_click', {
        event_label: 'phone_call'
      });
    });
  });
  // CTA button clicks
  document.querySelectorAll('.btn-primary').forEach(function (btn) {
    btn.addEventListener('click', function () {
      trackEvent('cta_click', {
        event_label: this.textContent.trim()
      });
    });
  });
  // Schedule clicks
  document.querySelectorAll('[data-track="schedule"]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      trackEvent('schedule_click', {});
    });
  });
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "script.js", error: String((e && e.message) || e) }); }

// ui_kits/website/CTABanner.jsx
try { (() => {
function CTABanner() {
  return /*#__PURE__*/React.createElement("section", {
    className: "cta-banner"
  }, /*#__PURE__*/React.createElement("div", {
    className: "container"
  }, /*#__PURE__*/React.createElement("h2", null, "Ready to Get Started?"), /*#__PURE__*/React.createElement("p", null, "Get your free estimate today. No hidden fees, no pressure \u2014 just honest, expert service."), /*#__PURE__*/React.createElement("div", {
    className: "btn-group"
  }, /*#__PURE__*/React.createElement("a", {
    href: "#",
    className: "btn btn-white"
  }, "Get Your Free Estimate"), /*#__PURE__*/React.createElement("a", {
    href: "tel:8005761397",
    className: "btn btn-outline-white"
  }, "Call (800) 576-1397"))));
}
window.CTABanner = CTABanner;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/CTABanner.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/Footer.jsx
try { (() => {
function Footer() {
  return /*#__PURE__*/React.createElement("footer", {
    className: "footer"
  }, /*#__PURE__*/React.createElement("div", {
    className: "container"
  }, /*#__PURE__*/React.createElement("div", {
    className: "footer-grid"
  }, /*#__PURE__*/React.createElement("div", {
    className: "footer-about"
  }, /*#__PURE__*/React.createElement("div", {
    className: "logo"
  }, /*#__PURE__*/React.createElement("img", {
    src: "../../assets/logo.png",
    alt: "Castle Garage Doors & Gates"
  })), /*#__PURE__*/React.createElement("p", null, "Veteran-owned, family-run garage door and gate service company. Proudly serving San Diego to Riverside County since 1981."), /*#__PURE__*/React.createElement("div", {
    className: "footer-social"
  }, /*#__PURE__*/React.createElement("a", {
    href: "#",
    "aria-label": "Facebook"
  }, /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 24 24"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M18 2h-3a5 5 0 00-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 011-1h3z"
  }))), /*#__PURE__*/React.createElement("a", {
    href: "#",
    "aria-label": "Yelp"
  }, /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 24 24"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
  }))), /*#__PURE__*/React.createElement("a", {
    href: "#",
    "aria-label": "Google"
  }, /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 24 24"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M21.35 11.1h-9.18v2.73h5.51c-.24 1.27-.98 2.34-2.09 3.06v2.54h3.39c1.98-1.82 3.12-4.51 3.12-7.58 0-.52-.05-1.02-.13-1.5z",
    fill: "#4285F4"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M12.17 22c2.84 0 5.22-.94 6.96-2.57l-3.39-2.54c-.94.63-2.15 1-3.57 1-2.74 0-5.06-1.85-5.89-4.34H2.76v2.62A10.5 10.5 0 0012.17 22z",
    fill: "#34A853"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M6.28 13.55a6.3 6.3 0 010-4.1V6.83H2.76a10.5 10.5 0 000 9.34l3.52-2.62z",
    fill: "#FBBC05"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M12.17 5.11c1.55 0 2.94.53 4.03 1.58l3.02-3.02C17.38 1.89 14.99.89 12.17.89A10.5 10.5 0 002.76 6.83l3.52 2.62c.83-2.49 3.15-4.34 5.89-4.34z",
    fill: "#EA4335"
  }))))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h4", null, "Services"), /*#__PURE__*/React.createElement("div", {
    className: "footer-links"
  }, /*#__PURE__*/React.createElement("a", {
    href: "#"
  }, "Garage Door Repair"), /*#__PURE__*/React.createElement("a", {
    href: "#"
  }, "New Garage Doors"), /*#__PURE__*/React.createElement("a", {
    href: "#"
  }, "Garage Door Openers"), /*#__PURE__*/React.createElement("a", {
    href: "#"
  }, "Gate Services"), /*#__PURE__*/React.createElement("a", {
    href: "#"
  }, "Emergency Repair"))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h4", null, "Service Areas"), /*#__PURE__*/React.createElement("div", {
    className: "footer-links"
  }, /*#__PURE__*/React.createElement("a", {
    href: "#"
  }, "San Diego"), /*#__PURE__*/React.createElement("a", {
    href: "#"
  }, "Escondido"), /*#__PURE__*/React.createElement("a", {
    href: "#"
  }, "Oceanside"), /*#__PURE__*/React.createElement("a", {
    href: "#"
  }, "Carlsbad"), /*#__PURE__*/React.createElement("a", {
    href: "#"
  }, "Temecula"), /*#__PURE__*/React.createElement("a", {
    href: "#"
  }, "Corona"))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h4", null, "Contact"), /*#__PURE__*/React.createElement("div", {
    className: "footer-links"
  }, /*#__PURE__*/React.createElement("a", {
    href: "tel:8005761397"
  }, "(800) 576-1397"), /*#__PURE__*/React.createElement("a", {
    href: "mailto:info@castlegaragedoors.com"
  }, "info@castlegaragedoors.com"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 'var(--text-small)',
      lineHeight: 1.4
    }
  }, "1291 Simpson Way Suite D", /*#__PURE__*/React.createElement("br", null), "Escondido, CA 92029")), /*#__PURE__*/React.createElement("a", {
    href: "#",
    className: "btn btn-primary btn-sm",
    style: {
      marginTop: 16,
      width: '100%',
      textAlign: 'center'
    }
  }, "Schedule Service"))), /*#__PURE__*/React.createElement("div", {
    className: "footer-bottom"
  }, /*#__PURE__*/React.createElement("p", null, "\xA9 2026 Castle Garage Inc. All rights reserved. | ", /*#__PURE__*/React.createElement("a", {
    href: "#"
  }, "Privacy"), " | ", /*#__PURE__*/React.createElement("a", {
    href: "#"
  }, "Terms")), /*#__PURE__*/React.createElement("div", {
    className: "footer-badges"
  }, /*#__PURE__*/React.createElement("span", {
    className: "footer-badge"
  }, "Home Depot Authorized"), /*#__PURE__*/React.createElement("span", {
    className: "footer-badge"
  }, "Clopay Dealer"), /*#__PURE__*/React.createElement("span", {
    className: "footer-badge"
  }, "BBB A+"), /*#__PURE__*/React.createElement("span", {
    className: "footer-badge"
  }, "Veteran-Owned"), /*#__PURE__*/React.createElement("span", {
    className: "footer-badge"
  }, "CSLB #1154002 (C-61/D-28)")))));
}
window.Footer = Footer;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/Footer.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/Header.jsx
try { (() => {
/* global React */
const {
  useState
} = React;
function Header() {
  const [open, setOpen] = useState(false);
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("header", {
    className: "header"
  }, /*#__PURE__*/React.createElement("div", {
    className: "header-inner"
  }, /*#__PURE__*/React.createElement("a", {
    href: "#",
    className: "logo"
  }, /*#__PURE__*/React.createElement("img", {
    src: "../../assets/logo.png",
    alt: "Castle Garage Doors & Gates"
  })), /*#__PURE__*/React.createElement("nav", {
    className: "nav-desktop"
  }, /*#__PURE__*/React.createElement("div", {
    className: "nav-dropdown"
  }, /*#__PURE__*/React.createElement("a", {
    href: "#services"
  }, "Services ", /*#__PURE__*/React.createElement("span", {
    className: "nav-arrow"
  }, "\u25BE")), /*#__PURE__*/React.createElement("div", {
    className: "mega-menu"
  }, /*#__PURE__*/React.createElement("a", {
    href: "#"
  }, "Garage Door Repair"), /*#__PURE__*/React.createElement("a", {
    href: "#"
  }, "New Garage Doors"), /*#__PURE__*/React.createElement("a", {
    href: "#"
  }, "Garage Door Openers"), /*#__PURE__*/React.createElement("a", {
    href: "#"
  }, "Gate Installation & Repair"), /*#__PURE__*/React.createElement("a", {
    href: "#"
  }, "Emergency Repair"), /*#__PURE__*/React.createElement("a", {
    href: "#",
    className: "mega-menu-viewall"
  }, "View All Services \u2192"))), /*#__PURE__*/React.createElement("a", {
    href: "#"
  }, "Service Areas"), /*#__PURE__*/React.createElement("a", {
    href: "#"
  }, "About"), /*#__PURE__*/React.createElement("a", {
    href: "#"
  }, "Reviews"), /*#__PURE__*/React.createElement("a", {
    href: "#"
  }, "Gallery"), /*#__PURE__*/React.createElement("a", {
    href: "#"
  }, "Blog"), /*#__PURE__*/React.createElement("a", {
    href: "#"
  }, "Contact")), /*#__PURE__*/React.createElement("div", {
    className: "header-right"
  }, /*#__PURE__*/React.createElement("div", {
    className: "header-phone"
  }, /*#__PURE__*/React.createElement("a", {
    href: "tel:8005761397"
  }, /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 24 24",
    fill: "currentColor"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M6.62 10.79a15 15 0 006.59 6.59l2.2-2.2a1 1 0 011.01-.24c1.12.37 2.33.57 3.58.57a1 1 0 011 1V20a1 1 0 01-1 1A17 17 0 013 4a1 1 0 011-1h3.5a1 1 0 011 1c0 1.25.2 2.46.57 3.58a1 1 0 01-.24 1.01l-2.21 2.2z"
  })), /*#__PURE__*/React.createElement("span", {
    className: "phone-text"
  }, "(800) 576-1397"))), /*#__PURE__*/React.createElement("a", {
    href: "#",
    className: "btn btn-primary btn-sm header-schedule"
  }, "Schedule Service"), /*#__PURE__*/React.createElement("button", {
    className: `hamburger ${open ? 'open' : ''}`,
    onClick: () => setOpen(!open),
    "aria-label": "Open menu"
  }, /*#__PURE__*/React.createElement("span", null), /*#__PURE__*/React.createElement("span", null), /*#__PURE__*/React.createElement("span", null))))), /*#__PURE__*/React.createElement("nav", {
    className: `mobile-menu ${open ? 'open' : ''}`
  }, /*#__PURE__*/React.createElement("a", {
    href: "#"
  }, "Services"), /*#__PURE__*/React.createElement("a", {
    href: "#"
  }, "Service Areas"), /*#__PURE__*/React.createElement("a", {
    href: "#"
  }, "About"), /*#__PURE__*/React.createElement("a", {
    href: "#"
  }, "Reviews"), /*#__PURE__*/React.createElement("a", {
    href: "#"
  }, "Gallery"), /*#__PURE__*/React.createElement("a", {
    href: "#"
  }, "Blog"), /*#__PURE__*/React.createElement("a", {
    href: "#"
  }, "Contact"), /*#__PURE__*/React.createElement("a", {
    href: "#",
    className: "btn btn-primary"
  }, "Schedule Service")));
}
window.Header = Header;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/Header.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/Hero.jsx
try { (() => {
function Hero() {
  return /*#__PURE__*/React.createElement("section", {
    className: "hero page-top"
  }, /*#__PURE__*/React.createElement("div", {
    className: "hero-bg",
    style: {
      backgroundImage: "url('../../assets/photos/hero/home-hero.png')"
    }
  }), /*#__PURE__*/React.createElement("div", {
    className: "hero-overlay"
  }), /*#__PURE__*/React.createElement("div", {
    className: "hero-content container"
  }, /*#__PURE__*/React.createElement("div", {
    className: "hero-heritage"
  }, "FAMILY-OWNED & OPERATED \xB7 SINCE 1981"), /*#__PURE__*/React.createElement("h1", null, "Garage Door ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--color-red)'
    }
  }, "&"), " Gate Repair"), /*#__PURE__*/React.createElement("p", {
    className: "hero-subtitle",
    style: {
      fontSize: '1.375rem',
      fontStyle: 'italic',
      opacity: 0.95,
      marginBottom: 'var(--space-2)'
    }
  }, "San Diego's Knight at the Gate"), /*#__PURE__*/React.createElement("p", null, "Expert repair, installation, and maintenance from San Diego to Riverside County. Licensed, bonded, and insured \u2014 CSLB #1154002."), /*#__PURE__*/React.createElement("div", {
    className: "hero-buttons"
  }, /*#__PURE__*/React.createElement("a", {
    href: "#",
    className: "btn btn-primary"
  }, "Schedule Service"), /*#__PURE__*/React.createElement("a", {
    href: "tel:8005761397",
    className: "btn btn-outline-white"
  }, "Call (800) 576-1397")), /*#__PURE__*/React.createElement("div", {
    className: "hero-trust"
  }, /*#__PURE__*/React.createElement("div", {
    className: "hero-trust-item"
  }, /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 24 24"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z"
  })), " 45+ Years Experience"), /*#__PURE__*/React.createElement("div", {
    className: "hero-trust-item"
  }, /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 24 24"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm.5 5H11v6l5.25 3.15.75-1.23-4.5-2.67V7z"
  })), " 24/7 Emergency Service"), /*#__PURE__*/React.createElement("div", {
    className: "hero-trust-item"
  }, /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 24 24"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"
  })), " Free Estimates"))));
}
window.Hero = Hero;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/Hero.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/ServicePillars.jsx
try { (() => {
function ServicePillars() {
  return /*#__PURE__*/React.createElement("section", {
    className: "section"
  }, /*#__PURE__*/React.createElement("div", {
    className: "container"
  }, /*#__PURE__*/React.createElement("div", {
    className: "section-header"
  }, /*#__PURE__*/React.createElement("span", {
    className: "section-label"
  }, "Our Services"), /*#__PURE__*/React.createElement("h2", null, "Expert Garage Door ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--color-red)'
    }
  }, "&"), " Gate Solutions"), /*#__PURE__*/React.createElement("p", null, "From emergency repairs to brand-new installations, we handle it all with over four decades of experience.")), /*#__PURE__*/React.createElement("div", {
    className: "services-pillars"
  }, /*#__PURE__*/React.createElement("div", {
    className: "service-pillar fade-up visible"
  }, /*#__PURE__*/React.createElement("div", {
    className: "pillar-img"
  }, /*#__PURE__*/React.createElement("img", {
    src: "../../assets/photos/pillars/garage-doors.png",
    alt: "Modern glass garage door installed by Castle in San Diego"
  })), /*#__PURE__*/React.createElement("h3", null, "Garage Doors"), /*#__PURE__*/React.createElement("p", null, "Repair, installation, and opener service for residential and commercial garage doors. Clopay Authorized Dealer with LiftMaster & Genie openers."), /*#__PURE__*/React.createElement("a", {
    href: "#",
    className: "btn btn-primary btn-sm"
  }, "Explore Garage Door Services \u2192")), /*#__PURE__*/React.createElement("div", {
    className: "service-pillar fade-up visible"
  }, /*#__PURE__*/React.createElement("div", {
    className: "pillar-img"
  }, /*#__PURE__*/React.createElement("img", {
    src: "../../assets/photos/pillars/gates.png",
    alt: "Custom wood-and-iron driveway gate by Castle in San Diego County"
  })), /*#__PURE__*/React.createElement("h3", null, "Gates"), /*#__PURE__*/React.createElement("p", null, "Automatic, driveway, security, and wrought iron gates. Installation, repair, and opener service \u2014 a specialty most competitors don't offer."), /*#__PURE__*/React.createElement("a", {
    href: "#",
    className: "btn btn-primary btn-sm"
  }, "Explore Gate Services \u2192")))));
}
window.ServicePillars = ServicePillars;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/ServicePillars.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/ServicesSection.jsx
try { (() => {
const SERVICES = [{
  icon: /*#__PURE__*/React.createElement("path", {
    d: "M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z"
  }),
  title: "Garage Door Repair",
  body: "Springs, cables, rollers, panels, tracks, sensors. Same-day and 24/7 emergency service.",
  cta: "Schedule Repair"
}, {
  icon: /*#__PURE__*/React.createElement("path", {
    d: "M12 3C6.95 3 3.15 4.85 0 7.23L12 22 24 7.25C20.85 4.87 17.05 3 12 3z"
  }),
  title: "Openers",
  body: "LiftMaster, Marantec, Genie. Smart/WiFi, belt drive, chain drive, wall-mount.",
  cta: "Explore Options"
}, {
  icon: /*#__PURE__*/React.createElement("path", {
    d: "M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm.5 5H11v6l5.25 3.15.75-1.23-4.5-2.67V7z"
  }),
  title: "Emergency Repair",
  body: "24/7 emergency service. Stuck door? Broken spring? Call any time.",
  cta: "Get Help Now"
}];
function ServicesSection() {
  return /*#__PURE__*/React.createElement("section", {
    className: "section",
    id: "services"
  }, /*#__PURE__*/React.createElement("div", {
    className: "container"
  }, /*#__PURE__*/React.createElement("div", {
    className: "section-header"
  }, /*#__PURE__*/React.createElement("span", {
    className: "section-label"
  }, "Our Services"), /*#__PURE__*/React.createElement("h2", null, "Expert Garage Door ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--color-red)'
    }
  }, "&"), " Gate Solutions"), /*#__PURE__*/React.createElement("p", null, "From emergency repairs to brand-new installations, we handle it all with over four decades of experience.")), /*#__PURE__*/React.createElement("div", {
    className: "services-grid"
  }, SERVICES.map((s, i) => /*#__PURE__*/React.createElement("div", {
    className: "service-card fade-up visible",
    key: i
  }, /*#__PURE__*/React.createElement("div", {
    className: "service-icon"
  }, /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 24 24"
  }, s.icon)), /*#__PURE__*/React.createElement("h3", null, s.title), /*#__PURE__*/React.createElement("p", null, s.body), /*#__PURE__*/React.createElement("a", {
    href: "#",
    className: "link"
  }, s.cta, " \u2192"))))));
}
window.ServicesSection = ServicesSection;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/ServicesSection.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/Testimonials.jsx
try { (() => {
const TESTIMONIALS = [{
  quote: "Castle replaced both springs and rollers on our garage door. The technician was on time, professional, and explained everything before starting. Fair pricing and excellent work. Highly recommend!",
  author: "Jennifer M.",
  source: "Escondido, CA · Spring & Roller Replacement · via Yelp"
}, {
  quote: "We had an emergency on a Saturday morning — our garage door cable snapped and the door was stuck. Castle came out within two hours and had everything fixed. Lifesavers!",
  author: "Robert & Maria T.",
  source: "Temecula, CA · Emergency Cable Repair · via Google"
}, {
  quote: "Veteran-owned and it shows in their work ethic. On time, professional, no BS. They diagnosed the problem quickly and fixed it at a fair price. Exactly what you want in a service company.",
  author: "Lt. Col. Dan R. (Ret.)",
  source: "Fallbrook, CA · Opener Repair · via Yelp"
}];
function Testimonials() {
  return /*#__PURE__*/React.createElement("section", {
    className: "section"
  }, /*#__PURE__*/React.createElement("div", {
    className: "container"
  }, /*#__PURE__*/React.createElement("div", {
    className: "section-header"
  }, /*#__PURE__*/React.createElement("span", {
    className: "section-label"
  }, "Customer Reviews"), /*#__PURE__*/React.createElement("h2", null, "What Our Customers Say"), /*#__PURE__*/React.createElement("p", null, "Rated 4.4 stars across 210+ reviews on Google and Yelp.")), /*#__PURE__*/React.createElement("div", {
    className: "testimonials-grid"
  }, TESTIMONIALS.map((t, i) => /*#__PURE__*/React.createElement("div", {
    className: "testimonial-card fade-up visible",
    key: i
  }, /*#__PURE__*/React.createElement("div", {
    className: "testimonial-stars"
  }, "\u2605\u2605\u2605\u2605\u2605"), /*#__PURE__*/React.createElement("blockquote", null, "\"", t.quote, "\""), /*#__PURE__*/React.createElement("div", {
    className: "testimonial-author"
  }, t.author), /*#__PURE__*/React.createElement("div", {
    className: "testimonial-source"
  }, t.source))))));
}
window.Testimonials = Testimonials;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/Testimonials.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/TrustStrip.jsx
try { (() => {
function TrustStrip() {
  return /*#__PURE__*/React.createElement("div", {
    className: "trust-strip"
  }, /*#__PURE__*/React.createElement("div", {
    className: "container"
  }, /*#__PURE__*/React.createElement("div", {
    className: "trust-strip-inner"
  }, /*#__PURE__*/React.createElement("div", {
    className: "trust-strip-item"
  }, /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 24 24"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z"
  })), " Since 1981"), /*#__PURE__*/React.createElement("div", {
    className: "trust-strip-item"
  }, /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 24 24"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
  })), " Veteran-Owned"), /*#__PURE__*/React.createElement("div", {
    className: "trust-strip-item"
  }, /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 24 24",
    fill: "currentColor"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"
  })), " Home Depot Authorized"), /*#__PURE__*/React.createElement("div", {
    className: "trust-strip-item"
  }, /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 24 24"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M19 19V5c0-1.1-.9-2-2-2H7c-1.1 0-2 .9-2 2v14H3v2h18v-2h-2zm-6 0H7V5h6v14z"
  })), " Clopay Authorized Dealer"), /*#__PURE__*/React.createElement("div", {
    className: "trust-strip-item"
  }, /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 24 24"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"
  })), " CSLB #1154002"))));
}
window.TrustStrip = TrustStrip;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/TrustStrip.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/WhyCastle.jsx
try { (() => {
const WHY_ITEMS = [{
  icon: /*#__PURE__*/React.createElement("path", {
    d: "M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z"
  }),
  title: "40+ Years of Experience",
  body: "Serving San Diego and Riverside County since 1981. Castle technicians average 15+ years of experience."
}, {
  icon: /*#__PURE__*/React.createElement("path", {
    d: "M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
  }),
  title: "Veteran-Owned & Operated",
  body: "Military values of discipline, integrity, and service excellence at the core of everything we do."
}, {
  icon: /*#__PURE__*/React.createElement("path", {
    d: "M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"
  }),
  title: "Authorized Home Depot Provider",
  body: "Trusted to serve 28 Home Depot stores as an authorized service provider — San Diego to Corona."
}, {
  icon: /*#__PURE__*/React.createElement("path", {
    d: "M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"
  }),
  title: "Licensed, Bonded & Insured",
  body: "CSLB License #1154002, C-61/D-28. Full liability coverage. Weekly OSHA safety training."
}];
function WhyCastle() {
  return /*#__PURE__*/React.createElement("section", {
    className: "section section-white"
  }, /*#__PURE__*/React.createElement("div", {
    className: "container"
  }, /*#__PURE__*/React.createElement("div", {
    className: "section-header"
  }, /*#__PURE__*/React.createElement("span", {
    className: "section-label"
  }, "Why Castle"), /*#__PURE__*/React.createElement("h2", null, "Why Homeowners Trust Castle"), /*#__PURE__*/React.createElement("p", null, "We've built our reputation one garage door at a time over more than four decades.")), /*#__PURE__*/React.createElement("div", {
    className: "why-grid"
  }, WHY_ITEMS.map((w, i) => /*#__PURE__*/React.createElement("div", {
    className: "why-item fade-up visible",
    key: i
  }, /*#__PURE__*/React.createElement("div", {
    className: "why-icon"
  }, /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 24 24"
  }, w.icon)), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h3", null, w.title), /*#__PURE__*/React.createElement("p", null, w.body)))))));
}
window.WhyCastle = WhyCastle;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/WhyCastle.jsx", error: String((e && e.message) || e) }); }

})();
