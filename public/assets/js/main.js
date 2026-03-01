// ── Navbar scroll effect ───────────────────────────────────
const navbar = document.getElementById('navbar');
window.addEventListener('scroll', () => {
  navbar.classList.toggle('scrolled', window.scrollY > 40);
});

// ── Mobile nav toggle ──────────────────────────────────────
const navToggle = document.querySelector('.nav-toggle');
const navLinks  = document.querySelector('.nav-links');

navToggle?.addEventListener('click', () => {
  navLinks.classList.toggle('open');
});

// Close mobile menu on link click
document.querySelectorAll('.nav-links a').forEach(link => {
  link.addEventListener('click', () => {
    navLinks.classList.remove('open');
  });
});

// ── Fade-up on scroll ──────────────────────────────────────
const fadeEls = document.querySelectorAll('.fade-up');
const observer = new IntersectionObserver(entries => {
  entries.forEach((entry, i) => {
    if (entry.isIntersecting) {
      setTimeout(() => entry.target.classList.add('visible'), i * 80);
      observer.unobserve(entry.target);
    }
  });
}, { threshold: 0.12 });
fadeEls.forEach(el => observer.observe(el));

// ── Contact form ───────────────────────────────────────────
const form = document.getElementById('contact-form');
form?.addEventListener('submit', async e => {
  e.preventDefault();
  const btn = form.querySelector('.form-submit .btn');
  const originalText = btn.textContent;
  btn.textContent = 'Enviando...';
  btn.disabled = true;

  try {
    const data = new FormData(form);
    const res  = await fetch('https://api.web3forms.com/submit', { method: 'POST', body: data });
    const json = await res.json();

    if (json.success) {
      btn.textContent    = '✓ Mensagem enviada!';
      btn.style.cssText  = 'background:#16A34A;cursor:default;';
      form.reset();
      setTimeout(() => {
        btn.textContent   = originalText;
        btn.style.cssText = '';
        btn.disabled      = false;
      }, 4000);
    } else {
      alert(json.message || 'Erro ao enviar. Tente novamente.');
      btn.textContent = originalText;
      btn.disabled    = false;
    }
  } catch {
    alert('Erro de conexão. Tente novamente ou fale pelo WhatsApp.');
    btn.textContent = originalText;
    btn.disabled    = false;
  }
});

// ── Smooth active nav highlight ────────────────────────────
const sections = document.querySelectorAll('section[id]');
const navAnchors = document.querySelectorAll('.nav-links a[href^="#"]');

window.addEventListener('scroll', () => {
  let current = '';
  sections.forEach(section => {
    if (window.scrollY >= section.offsetTop - 120) {
      current = section.id;
    }
  });
  navAnchors.forEach(a => {
    a.style.color = a.getAttribute('href') === `#${current}` ? 'var(--blue)' : '';
  });
}, { passive: true });
