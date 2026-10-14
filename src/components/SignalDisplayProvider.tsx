import {createContext,useContext,type ReactNode} from 'react';
import {defaultSignalDisplay,type SignalDisplaySettings} from '../domain/signal-display';
const Context=createContext(defaultSignalDisplay);
export function SignalDisplayProvider({settings,children}:{settings:SignalDisplaySettings;children:ReactNode}) {
  return <Context.Provider value={settings}>{children}</Context.Provider>;
}
export function useSignalDisplay(){return useContext(Context);}
