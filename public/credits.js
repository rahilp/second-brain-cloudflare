/** Human project credits (keep in sync with installer/src-tauri/src/credits.rs). */
window.SB_CREDITS = {
  creator: { name: "Rahil Pirani", github: "rahilp" },
  maintainers: [
    { name: "Vincenzo Fabiano" },
    { name: "Aneesh Grover", github: "Aneesh-382005" },
    { name: "Mike Stanley", github: "mikestanley00" },
    { name: "Mochammad Fadhlan Al-Ghiffari", github: "MFA-G" },
    { name: "Phillip Smith", github: "phillipadsmith" },
    { name: "Robert Brandin", github: "tumes" },
    { name: "oudouusa", github: "oudouusa" },
  ],
};

window.renderAboutCredits = function renderAboutCredits() {
  const root = document.getElementById("about-credits");
  if (!root) return;

  const { creator, maintainers } = window.SB_CREDITS;
  const personLine = (p) => {
    if (p.github) {
      const url = `https://github.com/${p.github}`;
      return `${p.name} (<a href="${url}" target="_blank" rel="noopener noreferrer">@${p.github}</a>)`;
    }
    return p.name;
  };

  root.innerHTML = `
    <div class="about-credits-label">${escHtml(t('menu.about'))}</div>
    <p class="about-credits-line"><span class="about-credits-kicker">${escHtml(t('menu.createdBy'))}</span> ${personLine(creator)}</p>
    <p class="about-credits-kicker">${escHtml(t('menu.maintainers'))}</p>
    <ul class="about-credits-list">
      ${maintainers.map((p) => `<li>${personLine(p)}</li>`).join("")}
    </ul>
  `;
};
