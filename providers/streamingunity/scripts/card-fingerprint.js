'use strict';
const {hash}=require('../../../shared/storage/json');
const COUNTERS=new Set(['views','daily_views','weekly_views','monthly_views','total_views','views_count',
  'visite','favorites','favorites_count','members','members_count']);
const isCounter=key=>typeof key==='string'&&(COUNTERS.has(key)||/^(.+)_([a-z]{2,3})$/.test(key)&&COUNTERS.has(key.replace(/_[a-z]{2,3}$/, '')));
function meaningful(value,predicate=isCounter){
  if(Array.isArray(value))return value.filter(v=>!(v&&typeof v==='object'&&predicate(v.key))).map(v=>meaningful(v,predicate));
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(k=>!predicate(k))
    .map(k=>[k,meaningful(value[k],predicate)]));
  return value;
}
function cardFingerprint(card){return hash(meaningful(card));}
function legacyCardFingerprint(card){return hash(meaningful(card,key=>COUNTERS.has(key)));}
function activityCounters(card){
  const result={};
  function visit(value,path){
    if(!value||typeof value!=='object')return;
    if(Array.isArray(value)){for(const entry of value){
      if(entry&&isCounter(entry.key))result[path+'/'+(entry.locale||'')+'/'+entry.key]=entry.value;
    }return;}
    for(const [key,child] of Object.entries(value)){
      const next=path+'/'+key;if(isCounter(key))result[next]=child;else visit(child,next);
    }
  }
  visit(card,'');return result;
}
module.exports={cardFingerprint,legacyCardFingerprint,activityCounters,isCounter};
