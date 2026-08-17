export function roundDownToTick(price: number): number {
  let tick = 1;
  if (price >= 2000000) {
    tick = 1000;
  } else if (price >= 1000000) {
    tick = 500;
  } else if (price >= 500000) {
    tick = 100;
  } else if (price >= 100000) {
    tick = 50;
  } else if (price >= 10000) {
    tick = 10;
  } else if (price >= 1000) {
    tick = 1;
  } else if (price >= 100) {
    tick = 0.1;
  } else if (price >= 10) {
    tick = 0.01;
  } else if (price >= 1) {
    tick = 0.001;
  } else {
    tick = 0.0001;
  }

  // 부동소수점 오차 방지를 위해 1 이상인 경우와 소수점 이하인 경우를 분리 처리
  if (tick >= 1) {
    return Math.floor(price / tick) * tick;
  } else {
    const multiplier = Math.round(1 / tick);
    return Math.floor(price * multiplier) / multiplier;
  }
}
