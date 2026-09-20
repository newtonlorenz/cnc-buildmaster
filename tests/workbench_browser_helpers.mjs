/** Test-only observation of actual UI transport. No globals are added to the app bundle. */
export async function observeTransport(page){
 await page.addInitScript(()=>{
  const observed=window.testTransport={state:null,job:null,pending:false};
  let pending=0;const request=window.fetch.bind(window);
  window.fetch=async(...args)=>{
   const [input,init]=args,url=String(input),mutation=init?.method==='POST'&&!/\/api\/(stop|jog-release|jog-pulse)$/.test(url);
   if(mutation)observed.pending=!!++pending;
   try{const response=await request(...args);
    if(response.ok&&/\/api\/(state|pcb)$/.test(url)){
     const data=await response.clone().json();if(url.endsWith('/state'))observed.state=data;else observed.job=data;
    }
    return response;
   }finally{if(mutation)observed.pending=!!--pending}
  };
 });
}
export async function appearance(page,value){
 const trigger=page.getByRole('button',{name:'Change appearance'});
 if(!await trigger.isVisible())await page.getByRole('button',{name:'Toggle Sidebar'}).first().click();
 await trigger.click();await page.getByRole('menuitemradio',{name:value==='system'?'Follow system':value==='light'?'Light':'Dark',exact:true}).click();
 const mobile=page.locator('[data-sidebar=sidebar][data-mobile=true]');
 if(await mobile.count())await mobile.getByRole('button',{name:'Close navigation',exact:true}).click();
}
export async function openUtility(page,name){
 await page.keyboard.press('Control+k');await page.getByPlaceholder('Search tools…').fill(name);
 await page.getByRole('option',{name:new RegExp(name,'i')}).first().click();
}
export async function closeUtility(page){await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).last().click()}
