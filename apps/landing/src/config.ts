export const config = {
  signupEndpoint: import.meta.env.PUBLIC_SIGNUP_ENDPOINT || 'https://api.nextaierp.com/v1/signup',
  // Replace with the business WhatsApp number, digits only, before launch.
  whatsappNumber: import.meta.env.PUBLIC_WHATSAPP_NUMBER || '000000000000',
  email: 'hello@nextaierp.com',
};
export const languages = { en: {label:'English',dir:'ltr'}, ml:{label:'മലയാളം',dir:'ltr'}, ar:{label:'العربية',dir:'rtl'} } as const;
// English is the source copy. Drop approved translations into these dictionaries.
export const translations: Record<string, Record<string,string>> = {en:{},ml:{},ar:{}};
