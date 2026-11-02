'use strict';
// Bounded, read-only production markup diagnostic. Never prints cookies or writes records.
const cheerio=require('cheerio');
const {Client}=require('./http');
const {parseAnime}=require('./parse');
(async()=>{
  const client=new Client({signal:AbortSignal.timeout(120000)});await client.discover();
  for(const [id,path] of [['5qnC4','/anime/hack-unison-ita-5qnC4'],['Ejp1m','/anime/12-sai-chicchana-mune-no-tokimeki-2-Ejp1m'],['PeB5s','/anime/22-7-8-3-PeB5s']]){
    const response=await client.get(path),$=cheerio.load(response.html);
    const result={id,url:response.url,ogUrl:$('meta[property="og:url"]').attr('content'),title:$('main h1').text().trim(),meta:$('.ag-meta').length,story:$('.story-clip').length,
      storyCandidates:$('[class*="story"],[class*="synop"],[class*="plot"]').map((_,e)=>({tag:e.tagName,class:$(e).attr('class'),text:$(e).text().trim().slice(0,160)})).get()};
    try{const r=parseAnime(response.html,client.baseUrl,{id,path},{});result.parsed=true;result.episodes=r.episodes.length;}catch(e){result.error=e.message;process.exitCode=1;}
    console.log(JSON.stringify(result));
  }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
