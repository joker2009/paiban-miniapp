import type { MeInfo } from '../miniprogram/types/index';

declare global {
  interface IAppOption {
    globalData: {
      me: MeInfo | null;
      meLoadedAt: number;
    };
  }
}

export {};
