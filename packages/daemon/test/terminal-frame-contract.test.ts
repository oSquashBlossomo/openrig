import { afterEach, expect, it, vi } from "vitest";
import { once } from "node:events";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import WebSocket from "ws";
import { browserBoundary } from "../src/middleware/browser-boundary.js";
import { registerTerminalWs } from "../src/routes/terminal-ws.js";
const cleanups: Array<()=>void>=[];
afterEach(()=>{for(const fn of cleanups.splice(0).reverse())fn();});
it("pins the stock 0.7.2/0.7.3 keys, literal text and subscriber scroll frame contract without Origin",async()=>{
  const calls:unknown[]=[];const app=new Hono();
  app.use("*",async(c,next)=>{c.set("tmuxAdapter" as never,{
    hasSession:async(name:string)=>name==="unmanaged-contract-shell",
    setWindowOption:async()=>({ok:true}),resizeWindow:async()=>({ok:true}),startPipePane:async()=>({ok:true}),stopPipePane:async()=>({ok:true}),
    sendKeys:async(_name:string,keys:string[])=>{if(keys[0])calls.push(["keys",keys]);return{ok:true};},
    sendText:async(_name:string,text:string)=>{calls.push(["text",text]);return{ok:true};},
    capturePaneContent:async(_name:string,lines:number)=>{calls.push(["scroll",lines]);return"scroll-proof\n".repeat(lines);},
  });await next();});
  app.use("/api/*",browserBoundary({webUiEnabled:true,bearerTokens:["contract-token"],warn:()=>{}}));
  const ws=createNodeWebSocket({app});registerTerminalWs(app,ws.upgradeWebSocket as never,{bearerToken:"contract-token"});
  const server=serve({fetch:app.fetch,hostname:"127.0.0.1",port:0});ws.injectWebSocket(server);cleanups.push(()=>server.close());if(!server.listening)await once(server,"listening");
  const socket=new WebSocket(`ws://127.0.0.1:${(server.address() as {port:number}).port}/api/terminal/unmanaged-contract-shell`,{headers:{Authorization:"Bearer contract-token"}});cleanups.push(()=>socket.terminate());
  const output:string[]=[];socket.on("message",data=>output.push(data.toString()));await once(socket,"open");
  for(const frame of [{type:"text",text:"literal; $(stays literal)"},{type:"keys",keys:["Enter"]},{type:"scroll",offset:3},{type:"resize",cols:1,rows:1}])socket.send(JSON.stringify(frame));
  await vi.waitFor(()=>{expect(calls).toContainEqual(["text","literal; $(stays literal)"]);expect(calls).toContainEqual(["keys",["Enter"]]);expect(calls).toContainEqual(["scroll",30]);expect(output.join("")).toContain("scroll-proof");});
  socket.close(1000);await once(socket,"close");
});
