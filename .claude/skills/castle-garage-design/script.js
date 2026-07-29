/* ===================================================================
   Castle Garage Doors & Gates — Shared JavaScript
   =================================================================== */

(function() {
  'use strict';

  // ===== FLOATING CTA (fades in after scroll) =====
  var header = document.getElementById('header');
  var floatingCta = document.getElementById('floatingCta');
  if (floatingCta) {
    window.addEventListener('scroll', function() {
      floatingCta.style.opacity = window.scrollY > 80 ? '1' : '0';
    }, { passive: true });
  }

  // ===== MOBILE MENU =====
  var hamburger = document.getElementById('hamburger');
  var mobileMenu = document.getElementById('mobileMenu');
  if (hamburger && mobileMenu) {
    hamburger.addEventListener('click', function() {
      var isOpen = mobileMenu.classList.toggle('open');
      hamburger.classList.toggle('open');
      hamburger.setAttribute('aria-expanded', isOpen);
      document.body.style.overflow = isOpen ? 'hidden' : '';
    });
  }
  // Close mobile menu on link click
  window.closeMobileMenu = function() {
    if (mobileMenu) mobileMenu.classList.remove('open');
    if (hamburger) {
      hamburger.classList.remove('open');
      hamburger.setAttribute('aria-expanded', 'false');
    }
    document.body.style.overflow = '';
  };
  document.querySelectorAll('.mobile-menu a').forEach(function(a) {
    a.addEventListener('click', window.closeMobileMenu);
  });

  // ===== SCROLL REVEAL =====
  if ('IntersectionObserver' in window) {
    var observer = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1 });
    document.querySelectorAll('.fade-up').forEach(function(el) { observer.observe(el); });
  }

  // ===== FORM HANDLING =====
  var form = document.getElementById('contactForm');
  if (form) {
    form.addEventListener('submit', function(e) {
      e.preventDefault();
      // TODO: Replace with ServiceTitan booking widget integration
      alert('Thank you! We received your request and will contact you shortly.\nFor immediate assistance, call (800) 576-1397.');
      form.reset();
    });
  }

  // ===== GALLERY FILTERS =====
  var galleryFilters = document.querySelectorAll('.gallery-filters button');
  if (galleryFilters.length) {
    galleryFilters.forEach(function(btn) {
      btn.addEventListener('click', function() {
        galleryFilters.forEach(function(b) { b.classList.remove('active'); });
        btn.classList.add('active');
        var filter = btn.getAttribute('data-filter');
        document.querySelectorAll('.gallery-item').forEach(function(item) {
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
    if (typeof gtag === 'function') { gtag('event', name, params); }
  }
  // Phone clicks
  document.querySelectorAll('a[href^="tel:"]').forEach(function(link) {
    link.addEventListener('click', function() { trackEvent('phone_click', { event_label: 'phone_call' }); });
  });
  // CTA button clicks
  document.querySelectorAll('.btn-primary').forEach(function(btn) {
    btn.addEventListener('click', function() {
      trackEvent('cta_click', { event_label: this.textContent.trim() });
    });
  });
  // Schedule clicks
  document.querySelectorAll('[data-track="schedule"]').forEach(function(btn) {
    btn.addEventListener('click', function() { trackEvent('schedule_click', {}); });
  });

})();
