/**
 * Second Brain — Browser Bookmarklet
 *
 * Setup:
 * 1. Replace YOUR_WORKER_URL with your Worker URL (e.g. second-brain.yourname.workers.dev)
 * 2. Replace YOUR_TOKEN with your AUTH_TOKEN secret
 * 3. Create a new bookmark in your browser
 * 4. Paste the entire javascript: line below as the bookmark URL
 * 5. Click it on any page to save to your second brain
 *
 * Usage:
 * - Click the bookmark with nothing selected → saves page title + URL
 * - Highlight text first → saves the selection + page title + URL
 */

// ─── Bookmarklet (minified — paste this as your bookmark URL) ─────────────────

javascript:(function(){
  const WORKER='https://YOUR_WORKER_URL/capture';
  const TOKEN='YOUR_TOKEN';
  const text=window.getSelection().toString().trim();
  const content=text?`${text}\n\n${document.title}\n${location.href}`:`${document.title}\n${location.href}`;
  fetch(WORKER,{method:'POST',headers:{'Authorization':`Bearer ${TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({content,source:'browser',tags:['reading']})}).then(r=>r.json()).then(()=>{const b=document.createElement('div');b.textContent='✓ Saved to brain';Object.assign(b.style,{position:'fixed',top:'20px',right:'20px',zIndex:'99999',background:'#1a1a1a',color:'#fff',padding:'10px 16px',borderRadius:'8px',fontSize:'14px'});document.body.appendChild(b);setTimeout(()=>b.remove(),2000)}).catch(()=>alert('Capture failed — check your token and Worker URL'));
})();