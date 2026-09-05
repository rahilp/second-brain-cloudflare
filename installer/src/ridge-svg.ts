// Ridge's inline artwork. One layered SVG, mounted once by `ridge.ts` and
// switched between poses entirely by `[data-ridge-state]` CSS (style.css,
// "Ridge, the guided-experience mascot") toggling opacity/transform on these
// groups — every pose is present in the DOM from the start so a state change
// never swaps markup or triggers layout.
//
// Sunglasses rule out blinking as a sign of life, so idle "aliveness" comes
// from the glasses' glint sweep and the three interchangeable brow poses
// instead. The mug arm and steam are hero-scale only (style.css hides them at
// dock size, where a mug is a smudge, not a mug).
export const RIDGE_SVG = `<svg viewBox="0 0 200 200" width="100%" height="100%" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <clipPath id="ridge-lens-l"><rect x="70" y="80" width="24" height="16" rx="6"/></clipPath>
    <clipPath id="ridge-lens-r"><rect x="106" y="80" width="24" height="16" rx="6"/></clipPath>
  </defs>

  <ellipse class="ridge-shadow" cx="100" cy="184" rx="44" ry="7" fill="var(--ridge-shadow)"/>

  <g class="ridge-arm--mug">
    <path d="M56 130 C40 128 30 140 32 156 C34 168 46 174 58 170" fill="none" stroke="var(--ridge-ink)" stroke-width="10" stroke-linecap="round"/>
    <g class="ridge-mug">
      <path d="M18 150 h26 v22 a13 13 0 0 1 -26 0 Z" fill="var(--bg-card)" stroke="var(--ridge-ink)" stroke-width="3"/>
      <path d="M44 156 c8 -2 10 6 2 8" fill="none" stroke="var(--ridge-ink)" stroke-width="3" stroke-linecap="round"/>
      <g class="ridge-steam" stroke="var(--text-tertiary)" stroke-width="2.5" fill="none" stroke-linecap="round">
        <path d="M24 146 c-4 -6 4 -8 0 -14"/>
        <path d="M32 146 c-4 -6 4 -8 0 -14"/>
      </g>
    </g>
  </g>

  <g class="ridge-body">
    <path class="ridge-body__fill" d="M56 136A16 16 0 0 1 44 110A16 16 0 0 1 48 80A19 19 0 0 1 70 52A17 17 0 0 1 100 42A16 16 0 0 1 130 46A17 17 0 0 1 150 66A15 15 0 0 1 158 94A15 15 0 0 1 150 120A17 17 0 0 1 130 146A16 16 0 0 1 100 154A15 15 0 0 1 76 146A11 11 0 0 1 56 136Z" fill="var(--accent)" stroke="var(--ridge-ink)" stroke-width="5" stroke-linejoin="round"/>
    <g class="ridge-body__folds" fill="none" stroke="var(--ridge-ink)" stroke-width="3.5" stroke-linecap="round">
      <path class="ridge-body__fold" d="M100 45 C95 52 105 58 100 65"/>
      <path class="ridge-body__fold" d="M70 55 C66 63 57 66 51 74"/>
      <path class="ridge-body__fold" d="M130 49 C136 56 145 60 150 68"/>
      <path class="ridge-body__fold" d="M47 87 C53 93 53 101 48 106"/>
      <path class="ridge-body__fold" d="M155 99 C148 105 148 112 152 117"/>
      <path class="ridge-body__fold" d="M78 127 C93 135 111 135 125 128"/>
    </g>

    <g class="ridge-brow--neutral" stroke="var(--ridge-ink)" stroke-width="4" stroke-linecap="round" fill="none">
      <path d="M68 74 h18"/>
      <path d="M114 74 h18"/>
    </g>
    <g class="ridge-brow--concerned" stroke="var(--ridge-ink)" stroke-width="4" stroke-linecap="round" fill="none" opacity="0">
      <path d="M68 78 L86 72"/>
      <path d="M132 78 L114 72"/>
    </g>
    <g class="ridge-brow--thinking" stroke="var(--ridge-ink)" stroke-width="4" stroke-linecap="round" fill="none" opacity="0">
      <path d="M68 72 L86 76"/>
      <path d="M114 74 h18"/>
    </g>

    <g class="ridge-glasses">
      <rect x="70" y="80" width="24" height="16" rx="6" fill="var(--ridge-ink)"/>
      <rect x="106" y="80" width="24" height="16" rx="6" fill="var(--ridge-ink)"/>
      <path d="M94 87 h12" stroke="var(--ridge-ink)" stroke-width="4"/>
      <path d="M70 86 L54 82" stroke="var(--ridge-ink)" stroke-width="4" stroke-linecap="round"/>
      <path d="M130 86 L146 82" stroke="var(--ridge-ink)" stroke-width="4" stroke-linecap="round"/>
      <g clip-path="url(#ridge-lens-l)">
        <rect class="ridge-glint ridge-glint--l" x="60" y="76" width="8" height="24" fill="var(--bg-card)" opacity=".55" transform="skewX(-20)"/>
      </g>
      <g clip-path="url(#ridge-lens-r)">
        <rect class="ridge-glint ridge-glint--r" x="96" y="76" width="8" height="24" fill="var(--bg-card)" opacity=".55" transform="skewX(-20)"/>
      </g>
    </g>

    <g class="ridge-mouth">
      <path class="ridge-mouth__pose--neutral" d="M92 108 h16" stroke="var(--ridge-ink)" stroke-width="4" stroke-linecap="round" fill="none"/>
      <path class="ridge-mouth__pose--talk" d="M92 106 q8 10 16 0" stroke="var(--ridge-ink)" stroke-width="4" stroke-linecap="round" fill="none" opacity="0"/>
      <path class="ridge-mouth__pose--concerned" d="M92 112 q8 -8 16 0" stroke="var(--ridge-ink)" stroke-width="4" stroke-linecap="round" fill="none" opacity="0"/>
      <path class="ridge-mouth__pose--smile" d="M88 106 q12 14 24 0" stroke="var(--ridge-ink)" stroke-width="4" stroke-linecap="round" fill="none" opacity="0"/>
    </g>

    <path class="ridge-sweat" d="M136 82 c4 4 4 10 0 14 c-4 -4 -4 -10 0 -14 Z" fill="var(--text-secondary)" opacity="0"/>

    <g class="ridge-think-dots" opacity="0">
      <circle class="ridge-dot" cx="112" cy="106" r="3" fill="var(--ridge-ink)"/>
      <circle class="ridge-dot" cx="122" cy="106" r="3" fill="var(--ridge-ink)"/>
      <circle class="ridge-dot" cx="132" cy="106" r="3" fill="var(--ridge-ink)"/>
    </g>
  </g>

  <g class="ridge-arm--free">
    <path d="M150 126 C168 122 180 132 178 148 C176 160 164 166 152 162" fill="none" stroke="var(--ridge-ink)" stroke-width="10" stroke-linecap="round"/>
  </g>

  <g class="ridge-sparkles">
    <path class="ridge-sparkle" style="--rx:30px;--ry:-40px" d="M40 60 l3 7 7 3 -7 3 -3 7 -3 -7 -7 -3 7 -3 Z" fill="var(--ok)"/>
    <path class="ridge-sparkle" style="--rx:-36px;--ry:-30px" d="M150 50 l3 7 7 3 -7 3 -3 7 -3 -7 -7 -3 7 -3 Z" fill="var(--accent)"/>
    <path class="ridge-sparkle" style="--rx:44px;--ry:6px" d="M160 110 l3 7 7 3 -7 3 -3 7 -3 -7 -7 -3 7 -3 Z" fill="var(--ok)"/>
    <path class="ridge-sparkle" style="--rx:-42px;--ry:14px" d="M36 120 l3 7 7 3 -7 3 -3 7 -3 -7 -7 -3 7 -3 Z" fill="var(--accent)"/>
  </g>
</svg>`;
