// Auto-generated from a Claude Design handoff (see decisions/ for context on the
// original brief). Pure CSS keyframe animation cycling through: film-strip cut →
// short/long-form/carousel cards → email/workshop/offer funnel fed by a YouTube CTA
// tree across 6 platforms (Reels, Shorts, TikTok, X, Threads, LinkedIn) → sleep/fun
// payoff → logo. No JS timers — every phase is driven by animation-name/-delay on a
// single shared --bg-cycle length, so it just loops via CSS.
const KEYFRAMES = `
@keyframes bg-film {
    0%    { opacity: 0; transform: translateX(-340px); animation-timing-function: cubic-bezier(.2,.6,.2,1); }
    4.3%  { opacity: 1; transform: translateX(0); }
    21.8% { opacity: 1; transform: translateX(0); }
    23.9% { opacity: 0; transform: translateX(0); }
    100%  { opacity: 0; transform: translateX(-340px); }
  }
  @keyframes bg-cut-left {
    0%    { transform: none; }
    15.7% { transform: none; animation-timing-function: cubic-bezier(.25,.46,.45,.94); }
    19.2% { transform: translateX(-6px) rotate(22deg); }
    23.9% { transform: translateX(-6px) rotate(22deg); }
    100%  { transform: none; }
  }
  @keyframes bg-cut-right {
    0%    { transform: none; }
    15.7% { transform: none; animation-timing-function: cubic-bezier(.25,.46,.45,.94); }
    19.2% { transform: translateX(6px) rotate(-22deg); }
    23.9% { transform: translateX(6px) rotate(-22deg); }
    100%  { transform: none; }
  }
  @keyframes bg-scissors {
    0%    { opacity: 0; transform: translateY(-36px); }
    4.3%  { opacity: 0; transform: translateY(-36px); }
    7%    { opacity: 1; transform: translateY(-36px); }
    10.9% { opacity: 1; transform: translateY(-36px); animation-timing-function: cubic-bezier(.4,0,1,1); }
    13.9% { opacity: 1; transform: translateY(0); }
    21.8% { opacity: 1; transform: translateY(0); }
    23.9% { opacity: 0; transform: translateY(0); }
    100%  { opacity: 0; transform: translateY(-36px); }
  }
  @keyframes bg-blade-a {
    0%    { transform: rotate(0deg); }
    7%    { transform: rotate(0deg); animation-timing-function: cubic-bezier(.2,.6,.2,1); }
    9.5%  { transform: rotate(28deg); }
    13.9% { transform: rotate(28deg); animation-timing-function: cubic-bezier(.4,0,.6,1); }
    15.2% { transform: rotate(0deg); }
    100%  { transform: rotate(0deg); }
  }
  @keyframes bg-blade-b {
    0%    { transform: rotate(0deg); }
    7%    { transform: rotate(0deg); animation-timing-function: cubic-bezier(.2,.6,.2,1); }
    9.5%  { transform: rotate(-28deg); }
    13.9% { transform: rotate(-28deg); animation-timing-function: cubic-bezier(.4,0,.6,1); }
    15.2% { transform: rotate(0deg); }
    100%  { transform: rotate(0deg); }
  }
  @keyframes bg-card {
    0%    { opacity: 0; transform: scale(.82); }
    21.8% { opacity: 0; transform: scale(.82); animation-timing-function: cubic-bezier(.2,.6,.2,1); }
    25.7% { opacity: 1; transform: scale(1); }
    40%   { opacity: 1; transform: scale(1); }
    42.7% { opacity: 0; transform: scale(.85); }
    100%  { opacity: 0; transform: scale(.82); }
  }
  @keyframes bg-stripe {
    0%    { transform: scaleX(0); }
    26.1% { transform: scaleX(0); animation-timing-function: cubic-bezier(.2,.6,.2,1); }
    28.4% { transform: scaleX(1); }
    42.7% { transform: scaleX(1); }
    44.5% { transform: scaleX(0); }
    100%  { transform: scaleX(0); }
  }
  @keyframes bg-logo {
    0%    { opacity: 0; transform: scale(.88); }
    84%   { opacity: 0; transform: scale(.88); animation-timing-function: cubic-bezier(.2,.6,.2,1); }
    90%   { opacity: 1; transform: scale(1); }
    97%   { opacity: 1; transform: scale(1); }
    100%  { opacity: 0; transform: scale(1); }
  }
  @keyframes bg-fn-el {
    0%, 43.5% { opacity: 0; transform: scale(.92); animation-timing-function: cubic-bezier(.2,.6,.2,1); }
    47%   { opacity: 1; transform: scale(1); }
    62.6% { opacity: 1; transform: scale(1); }
    63.5% { opacity: 0; transform: scale(1); }
    100%  { opacity: 0; transform: scale(.92); }
  }
  @keyframes bg-fn-cta {
    0%, 47.7% { opacity: 0; transform: scaleY(0); }
    48.5% { opacity: 1; transform: scaleY(0); animation-timing-function: cubic-bezier(.2,.6,.2,1); }
    53.2% { opacity: 1; transform: scaleY(1); }
    62.6% { opacity: 1; transform: scaleY(1); }
    63.5% { opacity: 0; transform: scaleY(1); }
    100%  { opacity: 0; transform: scaleY(0); }
  }
  @keyframes bg-fn-rise {
    0%, 53.2% { opacity: 0; transform: scaleY(0); }
    54%   { opacity: 1; transform: scaleY(0); animation-timing-function: cubic-bezier(.2,.6,.2,1); }
    58.3% { opacity: 1; transform: scaleY(1); }
    62.6% { opacity: 1; transform: scaleY(1); }
    63.5% { opacity: 0; transform: scaleY(1); }
    100%  { opacity: 0; transform: scaleY(0); }
  }
  @keyframes bg-fn-badge {
    0%, 58.3% { opacity: 0; transform: scale(.4); animation-timing-function: cubic-bezier(.2,.6,.2,1); }
    60.7% { opacity: 1; transform: scale(1); }
    62.6% { opacity: 1; transform: scale(1); }
    63.5% { opacity: 0; transform: scale(1); }
    100%  { opacity: 0; transform: scale(.4); }
  }
  @keyframes bg-fn-tip-cta {
    0%, 52.5% { opacity: 0; }
    53.2% { opacity: 1; }
    62.6% { opacity: 1; }
    63.5% { opacity: 0; }
    100%  { opacity: 0; }
  }
  @keyframes bg-fn-tip-rise {
    0%, 57.6% { opacity: 0; }
    58.3% { opacity: 1; }
    62.6% { opacity: 1; }
    63.5% { opacity: 0; }
    100%  { opacity: 0; }
  }
  @keyframes bg-hm-sleep {
    0%, 64.5% { opacity: 0; transform: scale(.94); animation-timing-function: cubic-bezier(.2,.6,.2,1); }
    67%   { opacity: 1; transform: scale(1); }
    73%   { opacity: 1; transform: scale(1); }
    74.5% { opacity: 0; transform: scale(1); }
    100%  { opacity: 0; transform: scale(.94); }
  }
  @keyframes bg-hm-fun {
    0%, 74.5% { opacity: 0; transform: scale(.94); animation-timing-function: cubic-bezier(.2,.6,.2,1); }
    77%   { opacity: 1; transform: scale(1); }
    81.5% { opacity: 1; transform: scale(1); }
    82.5% { opacity: 0; transform: scale(1); }
    100%  { opacity: 0; transform: scale(.94); }
  }
  @keyframes bg-hm-card {
    0%, 64.5% { opacity: 0; transform: scale(.94); animation-timing-function: cubic-bezier(.2,.6,.2,1); }
    67%   { opacity: 1; transform: scale(1); }
    81.5% { opacity: 1; transform: scale(1); }
    82.5% { opacity: 0; transform: scale(1); }
    100%  { opacity: 0; transform: scale(.94); }
  }
  @keyframes bg-hm-coin {
    0%   { opacity: 0; transform: translateX(0); animation-timing-function: cubic-bezier(.2,.6,.2,1); }
    18%  { opacity: 1; }
    78%  { opacity: 1; }
    100% { opacity: 0; transform: translateX(28px); }
  }
  @keyframes bg-hm-bal1 {
    0%, 66% { opacity: 0; }
    68%   { opacity: 1; }
    72%   { opacity: 1; }
    73.5% { opacity: 0; }
    100%  { opacity: 0; }
  }
  @keyframes bg-hm-bal2 {
    0%, 73.5% { opacity: 0; }
    74.5% { opacity: 1; }
    78%   { opacity: 1; }
    79%   { opacity: 0; }
    100%  { opacity: 0; }
  }
  @keyframes bg-hm-bal3 {
    0%, 79% { opacity: 0; }
    80%   { opacity: 1; }
    81.5% { opacity: 1; }
    82.5% { opacity: 0; }
    100%  { opacity: 0; }
  }
  @keyframes bg-dot {
    0%, 100% { opacity: 1; }
    50%      { opacity: .28; }
  }
`

const BANNER_HTML = `


  <div style="position: relative; width: 100%; max-width: 520px; height: 160px; display: flex; align-items: center; justify-content: center;">

    <div style="position: absolute; width: 320px; height: 36px; display: flex; animation-name: bg-film; animation-duration: var(--bg-cycle, 6.4s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear;">
      <div style="width: 50%; height: 100%; border: 1px solid #2196F3; border-right: none; border-radius: 2px 0 0 2px; background: #F4F0E8; display: flex; align-items: center; justify-content: space-evenly; transform-origin: left center; animation-name: bg-cut-left; animation-duration: var(--bg-cycle, 6.4s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear;">
        <div style="width: 2px; height: 20px; background: #2196F3; opacity: .9;"></div>
        <div style="width: 2px; height: 20px; background: #2196F3; opacity: .9;"></div>
        <div style="width: 2px; height: 20px; background: #2196F3; opacity: .9;"></div>
        <div style="width: 2px; height: 20px; background: #2196F3; opacity: .9;"></div>
      </div>
      <div style="width: 50%; height: 100%; border: 1px solid #2196F3; border-left: none; border-radius: 0 2px 2px 0; background: #F4F0E8; display: flex; align-items: center; justify-content: space-evenly; transform-origin: right center; animation-name: bg-cut-right; animation-duration: var(--bg-cycle, 6.4s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear;">
        <div style="width: 2px; height: 20px; background: #2196F3; opacity: .9;"></div>
        <div style="width: 2px; height: 20px; background: #2196F3; opacity: .9;"></div>
        <div style="width: 2px; height: 20px; background: #2196F3; opacity: .9;"></div>
        <div style="width: 2px; height: 20px; background: #2196F3; opacity: .9;"></div>
      </div>
    </div>

    <div style="position: absolute; display: flex; align-items: center; justify-content: center; animation-name: bg-scissors; animation-duration: var(--bg-cycle, 6.4s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear;">
      <svg width="28" height="48" viewBox="0 0 28 48" fill="none" aria-hidden="true">
        <circle cx="14" cy="22" r="2" fill="#2196F3" opacity="0.55"></circle>
        <g style="transform-box: view-box; transform-origin: 14px 22px; animation-name: bg-blade-a; animation-duration: var(--bg-cycle, 6.4s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear;">
          <circle cx="5" cy="5" r="4" stroke="#2196F3" stroke-width="1.8" fill="none"></circle>
          <line x1="5" y1="9" x2="14" y2="22" stroke="#2196F3" stroke-width="1.8" stroke-linecap="round"></line>
          <line x1="14" y1="22" x2="22" y2="45" stroke="#2196F3" stroke-width="1.8" stroke-linecap="round"></line>
        </g>
        <g style="transform-box: view-box; transform-origin: 14px 22px; animation-name: bg-blade-b; animation-duration: var(--bg-cycle, 6.4s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear;">
          <circle cx="23" cy="5" r="4" stroke="#2196F3" stroke-width="1.8" fill="none"></circle>
          <line x1="23" y1="9" x2="14" y2="22" stroke="#2196F3" stroke-width="1.8" stroke-linecap="round"></line>
          <line x1="14" y1="22" x2="6" y2="45" stroke="#2196F3" stroke-width="1.8" stroke-linecap="round"></line>
        </g>
      </svg>
    </div>

    <div style="position: absolute; transform: translateX(-114px);">
      <div style="width: 76px; height: 44px; border: 1px solid #2196F3; border-radius: 2px; background: #F4F0E8; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; animation-name: bg-card; animation-duration: var(--bg-cycle, 6.4s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear;">
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
          <polygon points="3,2 11,6.5 3,11" fill="#2196F3" opacity="0.75"></polygon>
        </svg>
        <span style="font-size: 6px; font-weight: 700; letter-spacing: 0.18em; color: #2196F3; text-align: center; line-height: 1.4;">LONG FORM<br>16:9</span>
      </div>
    </div>

    <div style="position: absolute;">
      <div style="width: 42px; height: 76px; border: 1px solid #2196F3; border-radius: 2px; background: #F4F0E8; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px; animation-name: bg-card; animation-duration: var(--bg-cycle, 6.4s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear; animation-delay: .09s;">
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
          <polygon points="3,2 11,6.5 3,11" fill="#2196F3" opacity="0.75"></polygon>
        </svg>
        <span style="font-size: 6px; font-weight: 700; letter-spacing: 0.18em; color: #2196F3; text-align: center; line-height: 1.4;">SHORT<br>FORM<br>9:16</span>
        <div style="display: flex; gap: 4px; align-items: center; margin-top: 2px;">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-label="Instagram">
            <rect x="2" y="2" width="20" height="20" rx="5" ry="5" stroke="#2196F3" stroke-width="2" fill="none" opacity="0.8"></rect>
            <circle cx="12" cy="12" r="4.5" stroke="#2196F3" stroke-width="2" fill="none" opacity="0.8"></circle>
            <circle cx="17.5" cy="6.5" r="1.2" fill="#2196F3" opacity="0.8"></circle>
          </svg>
          <svg width="10" height="11" viewBox="0 0 24 26" fill="none" aria-label="TikTok">
            <path d="M17 1c.5 3 2.5 5 5 5.5v4c-1.8 0-3.5-.5-5-1.5V18c0 4.4-3.6 8-8 8S1 22.4 1 18s3.6-8 8-8c.5 0 1 0 1.5.1V14c-.5-.1-1-.1-1.5-.1-2.2 0-4 1.8-4 4s1.8 4 4 4 4-1.8 4-4V1h4z" stroke="#2196F3" stroke-width="1.8" fill="none" stroke-linejoin="round" opacity="0.8"></path>
          </svg>
        </div>
      </div>
    </div>

    <div style="position: absolute; transform: translateX(109px);">
      <div style="width: 66px; height: 66px; border: 1px solid #2196F3; border-radius: 2px; background: #F4F0E8; overflow: hidden; display: flex; flex-direction: column; animation-name: bg-card; animation-duration: var(--bg-cycle, 6.4s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear; animation-delay: .18s;">
        <div style="font-size: 6px; font-weight: 700; letter-spacing: 0.18em; color: #2196F3; text-align: center; padding: 5px 0 3px; flex-shrink: 0;">CAROUSEL · 1:1</div>
        <div style="flex: 1; display: flex; flex-direction: column; gap: 2px; padding: 2px 4px 5px;">
          <div style="flex: 1; overflow: hidden; background: rgba(33,150,243,0.08);">
            <div style="width: 100%; height: 100%; background: rgba(33,150,243,0.18); transform-origin: left center; animation-name: bg-stripe; animation-duration: var(--bg-cycle, 6.4s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear;"></div>
          </div>
          <div style="flex: 1; overflow: hidden; background: rgba(33,150,243,0.08);">
            <div style="width: 100%; height: 100%; background: rgba(33,150,243,0.40); transform-origin: left center; animation-name: bg-stripe; animation-duration: var(--bg-cycle, 6.4s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear; animation-delay: .2s;"></div>
          </div>
          <div style="flex: 1; overflow: hidden; background: rgba(33,150,243,0.08);">
            <div style="width: 100%; height: 100%; background: rgba(33,150,243,0.62); transform-origin: left center; animation-name: bg-stripe; animation-duration: var(--bg-cycle, 6.4s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear; animation-delay: .4s;"></div>
          </div>
          <div style="flex: 1; overflow: hidden; background: rgba(33,150,243,0.08);">
            <div style="width: 100%; height: 100%; background: rgba(33,150,243,0.24); transform-origin: left center; animation-name: bg-stripe; animation-duration: var(--bg-cycle, 6.4s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear; animation-delay: .6s;"></div>
          </div>
        </div>
      </div>
    </div>

    <div style="position: absolute; width: 340px; display: flex; flex-direction: column; align-items: center;">
      <div style="display: flex; gap: 11px;">
        <div style="position: relative; width: 106px; height: 26px; border: 1px solid #2196F3; border-radius: 2px; background: #F4F0E8; display: flex; align-items: center; justify-content: center; animation-name: bg-fn-el; animation-duration: var(--bg-cycle, 9s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear;">
          <span style="font-size: 7px; font-weight: 700; letter-spacing: 0.16em; color: #2196F3;">EMAIL</span>
          <span style="position: absolute; top: -6px; right: -6px; width: 13px; height: 13px; border-radius: 50%; background: #2196F3; color: #FFFFFF; font-size: 7px; font-weight: 700; display: flex; align-items: center; justify-content: center; animation-name: bg-fn-badge; animation-duration: var(--bg-cycle, 9s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear;">$</span>
        </div>
        <div style="position: relative; width: 106px; height: 26px; border: 1px solid #2196F3; border-radius: 2px; background: #F4F0E8; display: flex; align-items: center; justify-content: center; animation-name: bg-fn-el; animation-duration: var(--bg-cycle, 9s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear; animation-delay: .05s;">
          <span style="font-size: 7px; font-weight: 700; letter-spacing: 0.16em; color: #2196F3;">WORKSHOP</span>
          <span style="position: absolute; top: -6px; right: -6px; width: 13px; height: 13px; border-radius: 50%; background: #2196F3; color: #FFFFFF; font-size: 7px; font-weight: 700; display: flex; align-items: center; justify-content: center; animation-name: bg-fn-badge; animation-duration: var(--bg-cycle, 9s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear; animation-delay: .08s;">$</span>
        </div>
        <div style="position: relative; width: 106px; height: 26px; border: 1px solid #2196F3; border-radius: 2px; background: #F4F0E8; display: flex; align-items: center; justify-content: center; animation-name: bg-fn-el; animation-duration: var(--bg-cycle, 9s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear; animation-delay: .1s;">
          <span style="font-size: 7px; font-weight: 700; letter-spacing: 0.16em; color: #2196F3;">OFFER</span>
          <span style="position: absolute; top: -6px; right: -6px; width: 13px; height: 13px; border-radius: 50%; background: #2196F3; color: #FFFFFF; font-size: 7px; font-weight: 700; display: flex; align-items: center; justify-content: center; animation-name: bg-fn-badge; animation-duration: var(--bg-cycle, 9s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear; animation-delay: .16s;">$</span>
        </div>
      </div>

      <div style="position: relative; width: 340px; height: 46px;">
        <div style="position: absolute; left: 0; top: 14px; width: 106px; height: 18px; box-sizing: border-box; border: 1px solid #2196F3; border-radius: 2px; background: #F4F0E8; display: flex; align-items: center; justify-content: center; gap: 4px; animation-name: bg-fn-el; animation-duration: var(--bg-cycle, 11.5s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear;">
          <svg width="11" height="11" viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="0" y="3" width="20" height="14" rx="5" stroke="#2196F3" stroke-width="1.6"></rect><path d="M8 7 L14 10 L8 13 Z" fill="#2196F3"></path></svg>
          <span style="font-size: 6px; font-weight: 700; letter-spacing: 0.16em; color: #2196F3;">YOUTUBE</span>
        </div>
        <div style="position: absolute; left: 52.25px; top: 0; width: 1.5px; height: 14px; background: #2196F3; transform-origin: bottom center; animation-name: bg-fn-rise; animation-duration: var(--bg-cycle, 11.5s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear;"></div>
        <div style="position: absolute; left: 52.25px; top: 32px; width: 1.5px; height: 14px; background: #2196F3; transform-origin: bottom center; animation-name: bg-fn-rise; animation-duration: var(--bg-cycle, 11.5s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear;"></div>
        <div style="position: absolute; left: 169.25px; bottom: 0; width: 1.5px; height: 46px; background: #2196F3; transform-origin: bottom center; animation-name: bg-fn-rise; animation-duration: var(--bg-cycle, 11.5s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear; animation-delay: .07s;"></div>
        <div style="position: absolute; left: 286.25px; bottom: 0; width: 1.5px; height: 46px; background: #2196F3; transform-origin: bottom center; animation-name: bg-fn-rise; animation-duration: var(--bg-cycle, 11.5s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear; animation-delay: .14s;"></div>
        <div style="position: absolute; left: 49.5px; top: 0; width: 0; height: 0; border-left: 3.5px solid transparent; border-right: 3.5px solid transparent; border-bottom: 5px solid #2196F3; animation-name: bg-fn-tip-rise; animation-duration: var(--bg-cycle, 11.5s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear;"></div>
        <div style="position: absolute; left: 49.5px; top: 32px; width: 0; height: 0; border-left: 3.5px solid transparent; border-right: 3.5px solid transparent; border-bottom: 5px solid #2196F3; animation-name: bg-fn-tip-rise; animation-duration: var(--bg-cycle, 11.5s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear;"></div>
        <div style="position: absolute; left: 166.5px; top: 0; width: 0; height: 0; border-left: 3.5px solid transparent; border-right: 3.5px solid transparent; border-bottom: 5px solid #2196F3; animation-name: bg-fn-tip-rise; animation-duration: var(--bg-cycle, 11.5s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear; animation-delay: .07s;"></div>
        <div style="position: absolute; left: 283.5px; top: 0; width: 0; height: 0; border-left: 3.5px solid transparent; border-right: 3.5px solid transparent; border-bottom: 5px solid #2196F3; animation-name: bg-fn-tip-rise; animation-duration: var(--bg-cycle, 11.5s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear; animation-delay: .14s;"></div>
        <span style="position: absolute; left: 57px; top: 2px; font-size: 6px; font-weight: 700; letter-spacing: 0.12em; color: #2196F3; animation-name: bg-fn-tip-rise; animation-duration: var(--bg-cycle, 11.5s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear;">CTA</span>
        <span style="position: absolute; left: 174px; top: 18px; font-size: 6px; font-weight: 700; letter-spacing: 0.12em; color: #2196F3; animation-name: bg-fn-tip-rise; animation-duration: var(--bg-cycle, 11.5s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear; animation-delay: .07s;">CTA</span>
        <span style="position: absolute; left: 291px; top: 18px; font-size: 6px; font-weight: 700; letter-spacing: 0.12em; color: #2196F3; animation-name: bg-fn-tip-rise; animation-duration: var(--bg-cycle, 11.5s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear; animation-delay: .14s;">CTA</span>
      </div>

      <div style="width: 340px; height: 10px; box-sizing: border-box; border: 1px solid #2196F3; border-radius: 2px; background: #F4F0E8; animation-name: bg-fn-el; animation-duration: var(--bg-cycle, 9s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear;"></div>

      <div style="position: relative; width: 340px; height: 16px;">
        <div style="position: absolute; left: 24.25px; bottom: 0; width: 1.5px; height: 16px; background: #2196F3; transform-origin: bottom center; animation-name: bg-fn-cta; animation-duration: var(--bg-cycle, 9s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear;"></div>
        <div style="position: absolute; left: 82.25px; bottom: 0; width: 1.5px; height: 16px; background: #2196F3; transform-origin: bottom center; animation-name: bg-fn-cta; animation-duration: var(--bg-cycle, 9s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear; animation-delay: .04s;"></div>
        <div style="position: absolute; left: 140.25px; bottom: 0; width: 1.5px; height: 16px; background: #2196F3; transform-origin: bottom center; animation-name: bg-fn-cta; animation-duration: var(--bg-cycle, 9s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear; animation-delay: .08s;"></div>
        <div style="position: absolute; left: 198.25px; bottom: 0; width: 1.5px; height: 16px; background: #2196F3; transform-origin: bottom center; animation-name: bg-fn-cta; animation-duration: var(--bg-cycle, 9s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear; animation-delay: .12s;"></div>
        <div style="position: absolute; left: 256.25px; bottom: 0; width: 1.5px; height: 16px; background: #2196F3; transform-origin: bottom center; animation-name: bg-fn-cta; animation-duration: var(--bg-cycle, 9s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear; animation-delay: .16s;"></div>
        <div style="position: absolute; left: 314.25px; bottom: 0; width: 1.5px; height: 16px; background: #2196F3; transform-origin: bottom center; animation-name: bg-fn-cta; animation-duration: var(--bg-cycle, 11.5s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear; animation-delay: .2s;"></div>
        <div style="position: absolute; left: 21.5px; top: 0; width: 0; height: 0; border-left: 3.5px solid transparent; border-right: 3.5px solid transparent; border-bottom: 5px solid #2196F3; animation-name: bg-fn-tip-cta; animation-duration: var(--bg-cycle, 11.5s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear;"></div>
        <div style="position: absolute; left: 79.5px; top: 0; width: 0; height: 0; border-left: 3.5px solid transparent; border-right: 3.5px solid transparent; border-bottom: 5px solid #2196F3; animation-name: bg-fn-tip-cta; animation-duration: var(--bg-cycle, 11.5s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear; animation-delay: .04s;"></div>
        <div style="position: absolute; left: 137.5px; top: 0; width: 0; height: 0; border-left: 3.5px solid transparent; border-right: 3.5px solid transparent; border-bottom: 5px solid #2196F3; animation-name: bg-fn-tip-cta; animation-duration: var(--bg-cycle, 11.5s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear; animation-delay: .08s;"></div>
        <div style="position: absolute; left: 195.5px; top: 0; width: 0; height: 0; border-left: 3.5px solid transparent; border-right: 3.5px solid transparent; border-bottom: 5px solid #2196F3; animation-name: bg-fn-tip-cta; animation-duration: var(--bg-cycle, 11.5s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear; animation-delay: .12s;"></div>
        <div style="position: absolute; left: 253.5px; top: 0; width: 0; height: 0; border-left: 3.5px solid transparent; border-right: 3.5px solid transparent; border-bottom: 5px solid #2196F3; animation-name: bg-fn-tip-cta; animation-duration: var(--bg-cycle, 11.5s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear; animation-delay: .16s;"></div>
        <div style="position: absolute; left: 311.5px; top: 0; width: 0; height: 0; border-left: 3.5px solid transparent; border-right: 3.5px solid transparent; border-bottom: 5px solid #2196F3; animation-name: bg-fn-tip-cta; animation-duration: var(--bg-cycle, 11.5s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear; animation-delay: .2s;"></div>
        <span style="position: absolute; left: 29px; top: 4px; font-size: 6px; font-weight: 700; letter-spacing: 0.12em; color: #2196F3; animation-name: bg-fn-tip-cta; animation-duration: var(--bg-cycle, 11.5s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear;">CTA</span>
        <span style="position: absolute; left: 87px; top: 4px; font-size: 6px; font-weight: 700; letter-spacing: 0.12em; color: #2196F3; animation-name: bg-fn-tip-cta; animation-duration: var(--bg-cycle, 11.5s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear; animation-delay: .04s;">CTA</span>
        <span style="position: absolute; left: 145px; top: 4px; font-size: 6px; font-weight: 700; letter-spacing: 0.12em; color: #2196F3; animation-name: bg-fn-tip-cta; animation-duration: var(--bg-cycle, 11.5s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear; animation-delay: .08s;">CTA</span>
        <span style="position: absolute; left: 203px; top: 4px; font-size: 6px; font-weight: 700; letter-spacing: 0.12em; color: #2196F3; animation-name: bg-fn-tip-cta; animation-duration: var(--bg-cycle, 11.5s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear; animation-delay: .12s;">CTA</span>
        <span style="position: absolute; left: 261px; top: 4px; font-size: 6px; font-weight: 700; letter-spacing: 0.12em; color: #2196F3; animation-name: bg-fn-tip-cta; animation-duration: var(--bg-cycle, 11.5s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear; animation-delay: .16s;">CTA</span>
        <span style="position: absolute; left: 319px; top: 4px; font-size: 6px; font-weight: 700; letter-spacing: 0.12em; color: #2196F3; animation-name: bg-fn-tip-cta; animation-duration: var(--bg-cycle, 11.5s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear; animation-delay: .2s;">CTA</span>
      </div>

      <div style="display: flex; gap: 8px;">
        <div style="width: 50px; height: 18px; border: 1px solid #2196F3; border-radius: 2px; background: #F4F0E8; display: flex; align-items: center; justify-content: center; animation-name: bg-fn-el; animation-duration: var(--bg-cycle, 9s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear;"><svg width="11" height="11" viewBox="0 0 20 20" fill="none" stroke="#2196F3" stroke-width="1.6" aria-hidden="true"><rect x="1" y="1" width="18" height="18" rx="5"></rect><circle cx="10" cy="10" r="4.5"></circle><circle cx="15" cy="5" r="1.2" fill="#2196F3" stroke="none"></circle></svg></div>
        <div style="width: 50px; height: 18px; border: 1px solid #2196F3; border-radius: 2px; background: #F4F0E8; display: flex; align-items: center; justify-content: center; animation-name: bg-fn-el; animation-duration: var(--bg-cycle, 9s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear; animation-delay: .04s;"><svg width="11" height="11" viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="1" y="2" width="18" height="16" rx="5" stroke="#2196F3" stroke-width="1.6"></rect><path d="M8 6.5 L14 10 L8 13.5 Z" fill="#2196F3"></path></svg></div>
        <div style="width: 50px; height: 18px; border: 1px solid #2196F3; border-radius: 2px; background: #F4F0E8; display: flex; align-items: center; justify-content: center; animation-name: bg-fn-el; animation-duration: var(--bg-cycle, 9s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear; animation-delay: .08s;"><svg width="11" height="11" viewBox="0 0 20 20" fill="none" stroke="#2196F3" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M12 2v10.2a3.3 3.3 0 1 1-2-3V2h2z"></path><path d="M12 2c.6 2.4 2.2 3.8 4 4.2"></path></svg></div>
        <div style="width: 50px; height: 18px; border: 1px solid #2196F3; border-radius: 2px; background: #F4F0E8; display: flex; align-items: center; justify-content: center; animation-name: bg-fn-el; animation-duration: var(--bg-cycle, 9s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear; animation-delay: .12s;"><svg width="10" height="10" viewBox="0 0 16 16" fill="#2196F3" aria-hidden="true"><path d="M12.6.75h2.454l-5.36 6.142L16 15.25h-4.937l-3.867-5.07-4.425 5.07H.316l5.733-6.57L0 .75h5.063l3.495 4.633L12.601.75Zm-.86 13.028h1.36L4.323 2.145H2.865z"></path></svg></div>
        <div style="width: 50px; height: 18px; border: 1px solid #2196F3; border-radius: 2px; background: #F4F0E8; display: flex; align-items: center; justify-content: center; animation-name: bg-fn-el; animation-duration: var(--bg-cycle, 9s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear; animation-delay: .16s;"><svg width="11" height="11" viewBox="0 0 16 16" fill="#2196F3" aria-hidden="true"><path d="M6.321 6.016c-.27-.18-1.166-.802-1.166-.802.756-1.081 1.753-1.502 3.132-1.502.975 0 1.803.327 2.394.948s.928 1.509 1.005 2.644q.492.207.905.484c1.109.745 1.719 1.86 1.719 3.137 0 2.716-2.226 5.075-6.256 5.075C4.594 16 1 13.987 1 7.994 1 2.034 4.482 0 8.044 0 9.69 0 13.55.243 15 5.036l-1.36.353C12.516 1.974 10.163 1.43 8.006 1.43c-3.565 0-5.582 2.171-5.582 6.79 0 4.143 2.254 6.343 5.63 6.343 2.777 0 4.847-1.443 4.847-3.556 0-1.438-1.208-2.127-1.27-2.127-.236 1.234-.868 3.31-3.644 3.31-1.618 0-3.013-1.118-3.013-2.582 0-2.09 1.984-2.847 3.55-2.847.586 0 1.294.04 1.663.114 0-.637-.54-1.728-1.9-1.728-1.25 0-1.566.405-1.967.868ZM8.716 8.19c-2.04 0-2.304.87-2.304 1.416 0 .878 1.043 1.168 1.6 1.168 1.02 0 2.067-.282 2.232-2.423a6.2 6.2 0 0 0-1.528-.161"></path></svg></div>
        <div style="width: 50px; height: 18px; border: 1px solid #2196F3; border-radius: 2px; background: #F4F0E8; display: flex; align-items: center; justify-content: center; animation-name: bg-fn-el; animation-duration: var(--bg-cycle, 9s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear; animation-delay: .2s;"><svg width="11" height="11" viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="1" y="1" width="18" height="18" rx="4" stroke="#2196F3" stroke-width="1.6"></rect><circle cx="6.3" cy="6.3" r="1.4" fill="#2196F3"></circle><line x1="6.3" y1="9.2" x2="6.3" y2="15" stroke="#2196F3" stroke-width="1.9" stroke-linecap="round"></line><path d="M10 15v-4c0-1.4 1-2.4 2.3-2.4S14.6 9.6 14.6 11v4" stroke="#2196F3" stroke-width="1.9" stroke-linecap="round"></path></svg></div>
      </div>
    </div>

    <div style="position: absolute; width: 340px; display: flex; align-items: center; justify-content: center; gap: 9px;">
      <div style="position: relative; width: 180px; height: 66px;">
        <div style="position: absolute; inset: 0; animation-name: bg-hm-sleep; animation-duration: var(--bg-cycle, 11.5s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear;">
          <svg width="180" height="66" viewBox="0 0 180 66" fill="none" stroke="#2196F3" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="8" y1="64" x2="172" y2="64"></line>
            <rect x="26" y="48" width="126" height="16" rx="3"></rect>
            <circle cx="50" cy="38" r="7"></circle>
            <path d="M68 48c9-5 20-5 29 0"></path>
            <path d="M108 48c7-4 15-4 22 0"></path>
            <path d="M60 26c3-3 7-3 10 0"></path>
            <path d="M66 18c3-3 7-3 10 0"></path>
          </svg>
        </div>
        <div style="position: absolute; inset: 0; animation-name: bg-hm-fun; animation-duration: var(--bg-cycle, 11.5s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear;">
          <svg width="180" height="66" viewBox="0 0 180 66" fill="none" stroke="#2196F3" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">
            <line x1="8" y1="64" x2="172" y2="64"></line>
            <circle cx="18" cy="13" r="6.5"></circle>
            <line x1="18" y1="2" x2="18" y2="4"></line>
            <line x1="7" y1="13" x2="9" y2="13"></line>
            <line x1="27" y1="13" x2="29" y2="13"></line>
            <line x1="10" y1="5" x2="12" y2="7"></line>
            <line x1="26" y1="5" x2="24" y2="7"></line>
            <line x1="158" y1="64" x2="158" y2="46"></line>
            <circle cx="158" cy="35" r="11"></circle>
            <circle cx="64" cy="21" r="6.5"></circle>
            <line x1="64" y1="27.5" x2="64" y2="45"></line>
            <line x1="64" y1="45" x2="57" y2="63"></line>
            <line x1="64" y1="45" x2="71" y2="63"></line>
            <line x1="64" y1="32" x2="52" y2="40"></line>
            <line x1="64" y1="32" x2="78" y2="40"></line>
            <circle cx="92" cy="36" r="5"></circle>
            <line x1="92" y1="41" x2="92" y2="53"></line>
            <line x1="92" y1="53" x2="87" y2="63"></line>
            <line x1="92" y1="53" x2="97" y2="63"></line>
            <line x1="92" y1="44" x2="79" y2="40"></line>
            <line x1="92" y1="44" x2="105" y2="40"></line>
            <circle cx="118" cy="21" r="6.5"></circle>
            <line x1="118" y1="27.5" x2="118" y2="45"></line>
            <line x1="118" y1="45" x2="111" y2="63"></line>
            <line x1="118" y1="45" x2="125" y2="63"></line>
            <line x1="118" y1="32" x2="106" y2="40"></line>
            <line x1="118" y1="32" x2="130" y2="38"></line>
          </svg>
        </div>
      </div>

      <div style="position: relative; width: 38px; height: 34px; animation-name: bg-hm-card; animation-duration: var(--bg-cycle, 11.5s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear;">
        <span style="position: absolute; left: 0; top: 1px; width: 10px; height: 10px; border-radius: 50%; background: #2196F3; color: #FFFFFF; font-size: 6px; font-weight: 700; display: flex; align-items: center; justify-content: center; animation-name: bg-hm-coin; animation-duration: 1.7s; animation-iteration-count: infinite; animation-timing-function: linear;">$</span>
        <span style="position: absolute; left: 0; top: 12px; width: 10px; height: 10px; border-radius: 50%; background: #2196F3; color: #FFFFFF; font-size: 6px; font-weight: 700; display: flex; align-items: center; justify-content: center; animation-name: bg-hm-coin; animation-duration: 1.7s; animation-iteration-count: infinite; animation-timing-function: linear; animation-delay: .55s;">$</span>
        <span style="position: absolute; left: 0; top: 23px; width: 10px; height: 10px; border-radius: 50%; background: #2196F3; color: #FFFFFF; font-size: 6px; font-weight: 700; display: flex; align-items: center; justify-content: center; animation-name: bg-hm-coin; animation-duration: 1.7s; animation-iteration-count: infinite; animation-timing-function: linear; animation-delay: 1.1s;">$</span>
      </div>

      <div style="width: 104px; box-sizing: border-box; border: 1px solid #2196F3; border-radius: 2px; background: #F4F0E8; padding: 7px 9px; display: flex; flex-direction: column; gap: 3px; animation-name: bg-hm-card; animation-duration: var(--bg-cycle, 11.5s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear;">
        <span style="font-size: 5px; font-weight: 700; letter-spacing: 0.22em; color: #3D3B35;">BALANCE</span>
        <div style="position: relative; height: 16px;">
          <span style="position: absolute; left: 0; top: 0; font-size: 13px; font-weight: 700; letter-spacing: -0.01em; color: #2196F3; animation-name: bg-hm-bal1; animation-duration: var(--bg-cycle, 11.5s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear;">$1,240</span>
          <span style="position: absolute; left: 0; top: 0; font-size: 13px; font-weight: 700; letter-spacing: -0.01em; color: #2196F3; animation-name: bg-hm-bal2; animation-duration: var(--bg-cycle, 11.5s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear;">$1,880</span>
          <span style="position: absolute; left: 0; top: 0; font-size: 13px; font-weight: 700; letter-spacing: -0.01em; color: #2196F3; animation-name: bg-hm-bal3; animation-duration: var(--bg-cycle, 11.5s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear;">$2,460</span>
        </div>
        <div style="display: flex; align-items: center; gap: 4px;">
          <span style="width: 0; height: 0; border-left: 2.5px solid transparent; border-right: 2.5px solid transparent; border-bottom: 4px solid #2196F3;"></span>
          <span style="font-size: 5px; font-weight: 700; letter-spacing: 0.2em; color: #2196F3;">DEPOSIT</span>
        </div>
      </div>
    </div>

    <div style="position: absolute; display: flex; align-items: center; gap: 18px; animation-name: bg-logo; animation-duration: var(--bg-cycle, 6.4s); animation-iteration-count: infinite; animation-fill-mode: backwards; animation-timing-function: linear;">
      <svg width="56" height="56" viewBox="0 0 72 72" fill="none" aria-hidden="true">
        <circle cx="24" cy="44" r="16" stroke="#2196F3" stroke-width="2" fill="none"></circle>
        <path d="M 7 39 A 22 22 0 0 1 50 31" stroke="#2196F3" stroke-width="2" fill="none"></path>
        <path d="M 11 41 A 18 18 0 0 1 46 33" stroke="#2196F3" stroke-width="2" fill="none"></path>
        <line x1="8" y1="30" x2="12" y2="31" stroke="#2196F3" stroke-width="1.6"></line>
        <line x1="11" y1="22" x2="14" y2="25" stroke="#2196F3" stroke-width="1.6"></line>
        <line x1="18" y1="16" x2="20" y2="20" stroke="#2196F3" stroke-width="1.6"></line>
        <line x1="26" y1="14" x2="27" y2="18" stroke="#2196F3" stroke-width="1.6"></line>
        <line x1="35" y1="15" x2="35" y2="19" stroke="#2196F3" stroke-width="1.6"></line>
        <line x1="43" y1="20" x2="41" y2="23" stroke="#2196F3" stroke-width="1.6"></line>
        <line x1="49" y1="28" x2="46" y2="30" stroke="#2196F3" stroke-width="1.6"></line>
        <g transform="rotate(-26, 48, 26)">
          <circle cx="54" cy="14" r="5" stroke="#2196F3" stroke-width="2.6" fill="none"></circle>
          <circle cx="54" cy="30" r="5" stroke="#2196F3" stroke-width="2.6" fill="none"></circle>
          <line x1="50" y1="17" x2="38" y2="26" stroke="#2196F3" stroke-width="2.6"></line>
          <line x1="50" y1="27" x2="38" y2="18" stroke="#2196F3" stroke-width="2.6"></line>
        </g>
      </svg>
      <div style="width: 1px; height: 52px; background: #D0CBC0;"></div>
      <div style="display: flex; flex-direction: column; gap: 6px;">
        <span style="font-size: 28px; font-weight: 700; color: #2196F3; letter-spacing: -0.02em; line-height: 1.1;">BrandGita</span>
        <span style="font-size: 10px; font-weight: 700; letter-spacing: 0.22em; color: #3D3B35; text-transform: uppercase;">Your Brand's Personal Stylist</span>
      </div>
    </div>

  </div>
`

export default function AnimatedBanner() {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: KEYFRAMES }} />
      <div
        style={{
          width: '100%',
          maxWidth: 520,
          margin: '0 auto',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 48,
          padding: '48px 16px',
          boxSizing: 'border-box',
          background: '#EBE7DB',
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
          overflow: 'hidden',
          '--bg-cycle': '11.5s',
        }}
        dangerouslySetInnerHTML={{ __html: BANNER_HTML }}
      />
    </>
  )
}
