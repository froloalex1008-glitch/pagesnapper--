
export async function listFlows(){ return [{ id:'f1', name:'F' }]; }
const H = "http://localhost:8099/";
const CASES = [
  { status_code:'Verified', business_type_classification:'Industrial', reasoning:'Makes pumps.',
    homepage_url:H, aboutus_page_url:H+'about-us/', services_page_url:H+'products/pumps/' },
  { status_code:'Verified', business_type_classification:'Industrial', reasoning:'Second co.',
    urls:{ homepage_url:H, about_us_page_url:H, services_page_url:'not available' } },
];
let i = 0;
export async function runFlow(){ return JSON.stringify({ outputs:[JSON.stringify([CASES[i++ % CASES.length]])] }); }
export { parseAgentResult, extractUrls } from '../flowhunt.js';
