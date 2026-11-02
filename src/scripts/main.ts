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
function setMarket(market:string){document.querySelectorAll<HTMLButtonElement>('[data-market]').forEach(b=>{const selected=b.dataset.market===market;b.classList.toggle('active',selected);b.setAttribute('aria-pressed',String(selected));});document.querySelectorAll('[data-price]').forEach(el=>el.textContent=market==='AE'?'[AED]':'[₹]');}
setMarket(country.value);
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
form.addEventListener('submit',async e=>{
 e.preventDefault();if(inFlight)return;
 const name=business.value.trim();let digits=phone.value.replace(/\D/g,'');
 if(phone.value.trim().startsWith('+')&&digits.startsWith(dial.value))digits=digits.slice(dial.value.length);
 if(dial.value==='971'&&digits.startsWith('0'))digits=digits.slice(1);
 const phoneOK=dial.value==='91'?/^[6-9]\d{9}$/.test(digits):/^5\d{8}$/.test(digits);
 $('#business-error').textContent=name?'':'Please enter your business name.';
 $('#phone-error').textContent=phoneOK?'':dial.value==='91'?'Enter a valid 10-digit Indian mobile number.':'Enter a UAE mobile number, for example 50 123 4567.';
 business.setAttribute('aria-invalid',String(!name));phone.setAttribute('aria-invalid',String(!phoneOK));
 if(!name||!phoneOK){(!name?business:phone).focus();return;}
 const submit=form.querySelector<HTMLButtonElement>('[type="submit"]')!;inFlight=true;submit.disabled=true;submit.textContent='Starting your free trial…';status.textContent='';status.className='';track('signup_submit',{country:country.value,language:language.value,plan:chosenPlan});
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),12000);
 try{
 const response=await fetch(form.dataset.endpoint!,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({businessName:name,phone:`+${dial.value}${digits}`,country:country.value,language:language.value,utm}),signal:controller.signal});
 if(!response.ok)throw new Error('signup failed');
 form.hidden=true;status.className='status-success';status.textContent='Check WhatsApp — we’ve sent you a message to get started.';
 const link=document.createElement('a');link.className='button';link.textContent='Open WhatsApp ↗';link.href=chatURL;link.target='_blank';link.rel='noopener noreferrer';
 if(hasWhatsApp)status.append(link);else{const note=document.createElement('p');note.textContent='The direct chat link is not configured yet. Contact hello@nextaierp.com if your message does not arrive.';status.append(note);}
 track('signup_success',{country:country.value});
 }catch{status.className='status-error';status.textContent='We couldn’t start your trial just now. Please try again, or use the WhatsApp link below. '+(!hasWhatsApp?'While our chat link is being connected, email hello@nextaierp.com.':'');track('signup_error');}
 finally{clearTimeout(timer);inFlight=false;submit.disabled=false;submit.innerHTML='Start free <span aria-hidden="true">↗</span>';}
});
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
