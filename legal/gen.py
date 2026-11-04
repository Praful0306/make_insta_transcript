# Generates the static legal pages. Run: python3 legal/gen.py  (fill the YELLOW placeholders first, then have a lawyer review)
CSS="""body{font:16px/1.6 system-ui,sans-serif;max-width:46rem;margin:0 auto;padding:24px 16px 64px;background:#fff;color:#1b1b1b}
@media(prefers-color-scheme:dark){body{background:#14181a;color:#e6e6e6}a{color:#7fc9b8}}
h1{font-size:1.6rem}h2{font-size:1.1rem;margin-top:1.8rem}.todo{background:#fff3b0;color:#000;padding:0 4px;border-radius:3px}
nav{font-size:.9rem;margin-bottom:20px}table{border-collapse:collapse}td,th{border:1px solid #8884;padding:6px 10px;text-align:left;vertical-align:top}"""
NAV='<nav><a href="/">Home</a> · <a href="privacy.html">Privacy</a> · <a href="terms.html">Terms</a> · <a href="refunds.html">Cancellation &amp; refunds</a> · <a href="data.html">Your data</a> · <a href="contact.html">Contact</a></nav>'
T=lambda s:'<span class="todo">'+s+'</span>'
BIZ=T("[LEGAL NAME OF THE BUSINESS OR PERSON]")
MAIL=T("[SUPPORT EMAIL]")
pages={}
pages["privacy"]=("Privacy Policy",f"""
<p>Last updated: {T("[DATE]")}. This service is run by {BIZ}, {T("[ADDRESS, INDIA]")} ("we"). Contact: {MAIL}.</p>
<h2>What data we use</h2>
<p>We keep this to the minimum. We do not sell your data, we do not run advertising, and we do not use your data to train any AI model.</p>
<table><tr><th>Mode</th><th>Data</th><th>Why</th><th>Where it lives</th></tr>
<tr><td>Free tools (your own keys)</td><td>Your Apify, Groq and Neon keys and database URL, typed in this page.</td><td>To run your own transcripts and store them in your own database.</td><td>Kept in your browser memory for the session. Sent with each request so the server can act for you. Our server does not store them, and the transcripts and rules go to your own Neon database, not ours.</td></tr>
<tr><td>Library (paid)</td><td>Email address, sign-in identity (from Firebase Authentication, run by Google), subscription status and dates, hashed API keys, and per-day usage counts (number of calls and rules).</td><td>To sign you in, check that you have paid, apply daily limits, and keep the service secure.</td><td>Sign-in data at Google Firebase. Everything else in our database at Neon.</td></tr>
<tr><td>Payments (when switched on)</td><td>Payment details are handled by Razorpay. We receive only the payment status, plan, amount and a reference. We never see or store your card, UPI or bank details.</td><td>To confirm payment and give access.</td><td>Razorpay, and our database (status and reference only).</td></tr></table>
<p>We do not store the text of what you ask AI tools. We log only the fact that a call was made (who, which endpoint, how many rules), never keys, tokens or rule text.</p>
<h2>Who processes data for us</h2>
<p>Google (Firebase Authentication), Neon (database hosting), Vercel (website hosting), Razorpay (payments, when enabled). Your own free-mode keys go to Apify, Groq and Neon only when you use those tools.</p>
<h2>Your choices and rights</h2>
<p>You can see, download and delete your data yourself on the Library page (<a href="data.html">details</a>), or write to {MAIL}. We answer within {T("[30]")} days. You can withdraw consent at any time by deleting your account. {T("[If you serve users in India, name your Grievance Officer here, with email and response time, as required by the Digital Personal Data Protection Act, 2023.]")}</p>
<h2>How long we keep it</h2>
<p>Account and usage data: until you delete the account. Payment records: as long as the law requires us to keep accounts and tax records. Usage counts older than {T("[90]")} days are removed.</p>
<h2>Security</h2>
<p>API keys are stored only as one-way hashes and are shown to you once. Access is checked on our server on every call. No method is perfectly secure, and we cannot promise otherwise.</p>
<h2>Children</h2><p>This service is not for people under 18.</p>
<h2>Changes</h2><p>If we change this policy in a meaningful way we will update the date above and tell signed-in members.</p>""")
pages["terms"]=("Terms of Use",f"""
<p>Last updated: {T("[DATE]")}. Operator: {BIZ}. By creating an account or paying you agree to these terms.</p>
<h2>What this is</h2>
<p>A tool that turns public videos into text, and a library of rules taken from traders' own words, with the exact quote and a link to the source. It is educational material only.</p>
<h2>No promises, no advice</h2>
<p>We do not promise any profit, accuracy, completeness or fitness for a purpose. We are not a registered investment adviser or research analyst and nothing here is investment advice or a recommendation to buy or sell anything. Trading involves a risk of loss. Rules are what a trader said, shown with the quote, and may be wrong, outdated or incomplete. Items marked "Not stated" were not said by the trader. You are responsible for checking anything before you rely on it, and for your own decisions and any indicator or strategy you build.</p>
<h2>What you pay for</h2>
<p>Paid members get access to the Library and API for the plan period, within the daily and per-minute limits shown on the Library page. Limits may be changed with notice. Content may be added, corrected or removed at any time, for example if a creator asks us to.</p>
<h2>Your use</h2>
<ul><li>For your own use. Do not resell, republish, share keys or accounts, or bulk copy the library to make a competing product.</li><li>Do not try to get around the payment lock, limits or security, and do not overload the service.</li><li>You are responsible for your own API keys. Revoke a key if you think it leaked.</li><li>When you transcribe videos with your own keys, you must have the right to use that content and follow the rules of each platform.</li></ul>
<h2>Content from others</h2><p>Videos and quotes belong to their creators. To ask for removal write to {MAIL}; we will review it promptly.</p>
<h2>Payments, cancellation, refunds</h2><p>See <a href="refunds.html">Cancellation &amp; refunds</a>.</p>
<h2>Ending access</h2><p>We may suspend accounts that break these terms. You can delete your account at any time.</p>
<h2>Liability</h2><p>To the extent the law allows, our total liability is limited to the amount you paid in the last 3 months, and we are not liable for trading losses or indirect loss. {T("[Lawyer: confirm governing law and courts, e.g. laws of India, courts at your city.]")}</p>""")
pages["refunds"]=("Cancellation and Refund Policy",f"""
<p>Last updated: {T("[DATE]")}. Operator: {BIZ}.</p>
<h2>Cancel any time</h2><p>Cancel from the Library page or by writing to {MAIL}. You keep access until the end of the period you already paid for, and you are not charged again.</p>
<h2>Refunds</h2>
<p>{T("[Decide and keep it simple, for example: If you are not satisfied, write to us within 7 days of your first payment and we will refund it in full, as long as you have used fewer than 50 API calls. After that, payments for a period already started are not refunded.]")} If we charged you by mistake or twice, we refund it. Refunds go back to the original payment method within {T("[5-7]")} working days.</p>
<h2>Delivery</h2><p>This is a digital service. Access is switched on right after payment is confirmed (usually within minutes). Nothing is shipped.</p>
<h2>Problems</h2><p>Write to {MAIL} with your account email. We reply within {T("[2]")} working days.</p>""")
pages["data"]=("Your Data: Download and Delete",f"""
<p>You control your data. Sign in on the <a href="/#lib">Library page</a>:</p>
<ul><li><b>Download my data</b> gives you a file with your account, subscription, API key list (never the keys themselves) and usage.</li><li><b>Delete my account</b> removes your account, API keys and usage history from our database and your sign-in from Firebase. It cannot be undone. Cancel your plan first if you do not want to lose paid days; deleting does not by itself refund a payment.</li></ul>
<p>Free-mode transcripts and rules are in your own Neon database. You can export or delete them there at any time; we do not hold a copy.</p>
<p>If you cannot sign in, write to {MAIL} from your account email and we will help.</p>""")
pages["contact"]=("Contact",f"""
<p>{BIZ}<br>{T("[REGISTERED ADDRESS]")}<br>Email: {MAIL}<br>Phone: {T("[PHONE]")}</p>
<p>Support hours: {T("[e.g. Mon-Sat 10:00-18:00 IST]")}. Grievance officer: {T("[NAME, EMAIL]")}.</p>""")
for k,(t,b) in pages.items():
    open(f"legal/{k}.html","w").write(f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{t}</title><style>{CSS}</style></head><body>{NAV}<h1>{t}</h1>{b}</body></html>')
