// 游戏页面的入口：挂上 Preact 的界面，再启动游戏。地图画在 #map 画布上，界面叠在 #hud 里。
import { render } from 'preact';
import { Hud } from './components.tsx';
import { startGame } from './game.ts';

const hud = document.getElementById('hud');
const canvas = document.getElementById('map');
if (!(hud instanceof HTMLElement) || !(canvas instanceof HTMLCanvasElement)) throw new Error('the page is missing #hud or #map');

render(<Hud />, hud);
startGame({ canvas, hud }, window.location.search).catch((error: unknown) => {
  console.error(error);
});
