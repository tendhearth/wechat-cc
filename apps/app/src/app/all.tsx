import { WelcomeGate } from '../ui/WelcomeGate'
import { Redirect } from 'expo-router'

// Historical links land in the conversation’s temporary search layer.
export default function All() { return <WelcomeGate><Redirect href="/chat-search?scope=work" /></WelcomeGate> }
