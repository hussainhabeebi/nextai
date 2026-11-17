import { config, translations } from '../config';
const $ = <T extends Element = HTMLElement>(selector:string) => document.querySelector<T>(selector)!;
const dialog = $<HTMLDialogElement>('#signup');
const form = $<HTMLFormElement>('#signup-form');
const country = $<HTMLSelectElement>('#country');
const dial = $<HTMLSelectElement>('#dial');
const phone = $<HTMLInputElement>('#phone');
const business = $<HTMLInputElement>('#business');
const status = $('#form-status');
const language = $<HTMLSelectElement>('#language');
const utm:Record<string,string> = {};
const params = new URLSearchParams(location.search);
['utm_source','utm_medium','utm_campaign','utm_term','utm_content'].forEach(k=>{const v=params.get(k);if(v)utm[k]=v.slice(0,300)});
let chosenPlan='';
// Connect an analytics provider to this event without sending personal form data.
function track(name:string, detail:Record<string,unknown>={}){window.dispatchEvent(new CustomEvent('nextai:analytics',{detail:{event:name,...detail,utm}}));}
const isAE = navigator.language.toLowerCase().includes('-ae') || Intl.DateTimeFormat().resolvedOptions().timeZone === 'Asia/Dubai';
country.value=isAE?'AE':'IN'; dial.value=isAE?'971':'91';
const inr=(v?:string)=>`₹${Number(v).toLocaleString('en-IN')}`;
function setMarket(market:string){document.querySelectorAll<HTMLButtonElement>('[data-market]').forEach(b=>{const selected=b.dataset.market===market;b.classList.toggle('active',selected);b.setAttribute('aria-pressed',String(selected));});document.querySelectorAll<HTMLElement>('[data-price]').forEach(el=>el.textContent=market==='AE'?`AED ${el.dataset.aed}`:inr(el.dataset.inr));document.querySelectorAll<HTMLElement>('[data-gst]').forEach(el=>el.hidden=market==='AE');}
setMarket(isAE?'AE':'IN');
document.querySelectorAll<HTMLButtonElement>('[data-market]').forEach(b=>b.addEventListener('click',()=>setMarket(b.dataset.market!)));
country.addEventListener('change',()=>{dial.value=country.value==='AE'?'971':'91'});
dial.addEventListener('change',()=>{country.value=dial.value==='971'?'AE':'IN'});
const hasWhatsApp=/^[1-9]\d{7,14}$/.test(config.whatsappNumber);
const chatURL=`https://wa.me/${config.whatsappNumber}?text=${encodeURIComponent('START')}`;
document.querySelectorAll<HTMLAnchorElement>('[data-chat]').forEach(a=>{a.href=chatURL;a.target='_blank';a.rel='noopener noreferrer';a.addEventListener('click',e=>{track('whatsapp_click');if(!hasWhatsApp){e.preventDefault();if(!dialog.open)dialog.showModal();status.className='status-error';status.textContent='Our WhatsApp link is being connected. Please contact hello@nextaierp.com for help.'}})});
if(hasWhatsApp)document.querySelectorAll('.setup-notice').forEach(n=>n.remove());
document.querySelectorAll<HTMLButtonElement>('[data-signup]').forEach(button=>button.addEventListener('click',()=>{chosenPlan=button.dataset.plan||'';track('cta_click',{plan:chosenPlan,placement:button.closest('section')?.id||'landing'});dialog.showModal();}));
$('.close').addEventListener('click',()=>dialog.close());
dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close()}});
let inFlight=false;
const owner=$<HTMLInputElement>('#owner');
const email=$<HTMLInputElement>('#email');
const website=$<HTMLInputElement>('#website');
const codeForm=$<HTMLFormElement>('#code-form');
const code=$<HTMLInputElement>('#code');
const verifyURL=form.dataset.endpoint!.replace(/\/+$/,'')+'/verify';
let signupId='';
// "Anil 98765 43210" / "Rasheed - 050 123 4567" per line → [{name, phone}] (numbers without a + use the dial code).
const teamList=()=>{const lines=($<HTMLTextAreaElement>('#team').value||'').split(/\n|;/).map(l=>l.trim()).filter(Boolean);const out=lines.map(l=>{const em=l.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/)?.[0];const rest=em?l.replace(em,' '):l;const m=rest.match(/(\+?[\d][\d\s-]{7,})/);if(!m)return null;const raw=m[1]!.replace(/[\s-]/g,'');const nm=rest.replace(m[1]!,'').replace(/[-,:]+/g,' ').replace(/\s+/g,' ').trim()||'Staff';return {name:nm.slice(0,80),phone:raw.startsWith('+')?raw:`+${dial.value}${raw.replace(/^0+/,'')}`,...(em?{email:em.toLowerCase()}:{})};}).filter(Boolean).slice(0,9);return out.length?out:undefined;};
const planOf=(p:string)=>['base','growth','pro'].includes(p)?p:undefined;
const errorText=async(r:Response)=>{try{const j=await r.json();return typeof j?.message==='string'?j.message:''}catch{return''}};
form.addEventListener('submit',async e=>{
 e.preventDefault();if(inFlight)return;
 const name=business.value.trim();const ownerName=owner.value.trim();const mail=email.value.trim();let digits=phone.value.replace(/\D/g,'');
 if(phone.value.trim().startsWith('+')&&digits.startsWith(dial.value))digits=digits.slice(dial.value.length);
 if(dial.value==='971'&&digits.startsWith('0'))digits=digits.slice(1);
 const phoneOK=dial.value==='91'?/^[6-9]\d{9}$/.test(digits):/^5\d{8}$/.test(digits);
 const mailOK=/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail);
 $('#business-error').textContent=name?'':'Please enter your business name.';
 $('#owner-error').textContent=ownerName?'':'Please enter your name.';
 $('#email-error').textContent=mailOK?'':'Enter a valid email; we send your code there.';
 $('#phone-error').textContent=phoneOK?'':dial.value==='91'?'Enter a valid 10-digit Indian mobile number.':'Enter a UAE mobile number, for example 50 123 4567.';
 business.setAttribute('aria-invalid',String(!name));owner.setAttribute('aria-invalid',String(!ownerName));email.setAttribute('aria-invalid',String(!mailOK));phone.setAttribute('aria-invalid',String(!phoneOK));
 if(!name||!ownerName||!mailOK||!phoneOK){(!name?business:!ownerName?owner:!mailOK?email:phone).focus();return;}
 const submit=form.querySelector<HTMLButtonElement>('[type="submit"]')!;inFlight=true;submit.disabled=true;submit.textContent='Sending your code…';status.textContent='';status.className='';track('signup_submit',{country:country.value,language:language.value,plan:chosenPlan});
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),15000);
 try{
  const response=await fetch(form.dataset.endpoint!,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({businessName:name,ownerName,email:mail,phone:`+${dial.value}${digits}`,country:country.value,language:language.value,plan:planOf(chosenPlan),team:teamList(),utm,website:website.value||undefined}),signal:controller.signal});
  if(!response.ok){const msg=await errorText(response);throw new Error(msg||'signup failed');}
  const body=await response.json() as {signupId:string;devCode?:string};
  signupId=body.signupId;form.hidden=true;codeForm.hidden=false;if(body.devCode)code.value=body.devCode;
  status.className='status-success';status.textContent=`We’ve emailed a 6-digit code to ${mail}. Check spam if you don’t see it.`;
  code.focus();track('signup_code_sent',{country:country.value});
 }catch(err){status.className='status-error';status.textContent=(err as Error).message&&(err as Error).message!=='signup failed'?(err as Error).message:'We couldn’t start your trial just now. Please try again, or email hello@nextaierp.com.';track('signup_error');}
 finally{clearTimeout(timer);inFlight=false;submit.disabled=false;submit.innerHTML='Start free <span aria-hidden="true">↗</span>';}
});
codeForm.addEventListener('submit',async e=>{
 e.preventDefault();if(inFlight)return;
 const value=code.value.replace(/\D/g,'');
 $('#code-error').textContent=/^\d{6}$/.test(value)?'':'Enter the 6 digits from the email.';
 if(!/^\d{6}$/.test(value)){code.focus();return;}
 const submit=codeForm.querySelector<HTMLButtonElement>('[type="submit"]')!;inFlight=true;submit.disabled=true;submit.textContent='Setting up your books…';
 try{
  const response=await fetch(verifyURL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({signupId,code:value})});
  if(!response.ok){const msg=await errorText(response);throw new Error(msg||'That code didn’t work. Please try again.');}
  const body=await response.json() as {loginUrl:string};
  status.className='status-success';status.textContent='You’re in! Opening NextAi…';track('signup_success',{country:country.value});
  location.href=body.loginUrl;
 }catch(err){status.className='status-error';status.textContent=(err as Error).message;track('signup_verify_error');}
 finally{inFlight=false;submit.disabled=false;submit.innerHTML='Verify and open NextAi <span aria-hidden="true">↗</span>';}
});
$('#code-back').addEventListener('click',()=>{codeForm.hidden=true;form.hidden=false;status.textContent='';status.className='';signupId='';});
language.addEventListener('change',()=>{const url=new URL(language.value==='en'?'/':`/${language.value}/`,location.origin);url.search=location.search;location.href=url.href;});
const lang=document.documentElement.lang;
// Text keys can be replaced independently when approved translations are available.
document.querySelectorAll<HTMLElement>('[data-i18n]').forEach(el=>{const value=translations[lang]?.[el.dataset.i18n!];if(value)el.textContent=value;});
if(lang!=='en'){const notice=document.createElement('p');notice.className='translation-notice';notice.style.cssText='margin:0;text-align:center;padding:8px 20px;background:#eaf0dd;font-size:12px';notice.textContent=lang==='ml'?'മലയാളം പരിഭാഷ ഉടൻ ലഭ്യമാകും. ഇപ്പോൾ ഇംഗ്ലീഷ് ഉള്ളടക്കമാണ് കാണിക്കുന്നത്.':'الترجمة العربية قريباً. المحتوى معروض بالإنجليزية حالياً.';document.querySelector('header')!.after(notice);document.querySelector('main')!.setAttribute('lang','en');}
const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
if('IntersectionObserver' in window){
 const mobile=$<HTMLElement>('.mobile-cta');new IntersectionObserver(([e])=>{mobile.hidden=e.isIntersecting||e.boundingClientRect.top>0;},{threshold:0}).observe($('.hero'));
 if(!reduced){document.documentElement.classList.add('js-motion');const reveal=new IntersectionObserver(entries=>entries.forEach(e=>{if(e.isIntersecting){e.target.classList.add('visible');reveal.unobserve(e.target)}}),{threshold:.1});document.querySelectorAll('.reveal').forEach(el=>reveal.observe(el));}
}
// Every visible source string can be translated without editing the page structure.
// Example: translations.ml['Start free'] = '...'. Do not translate user input.
const dictionary=translations[lang]||{};
const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,{acceptNode(node){return node.parentElement?.closest('script,style,[data-i18n],.translation-notice')?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT;}});
let textNode:Node|null;
while((textNode=walker.nextNode())){const source=textNode.textContent?.trim();if(source&&dictionary[source])textNode.textContent=textNode.textContent!.replace(source,dictionary[source]);}
