import * as ethers from 'ethers'
import axios, { AxiosInstance } from 'axios'
import Wallet from './wallet'

ethers.errors.setLogLevel('error')

export default class Metacash {
    
    options: any = {
        version:"2.0.0",
        relay:"https://v2.relay.lamarkaz.com",
        factory:"0xBcC1F7a800e77F59E64Fd39F6Fd96FE89d31581B",
        provider:"ropsten",
        InfuraAccessToken:"500f69b524a04c1b8eddc8c43b31541f",
        relayAddress:"0x0f79f829cF884078DCB755d1068daC54994CF7C0"
    }

    wallet: Wallet | undefined
    
    relayAPI: AxiosInstance

    constructor(opts: object = {}) {
        this.options = Object.assign(this.options, opts)
        this.relayAPI = axios.create({
            baseURL: this.options.relay,
            timeout: 30000
        });
    }

    async create(password: string) {
        var unencryptedWallet = ethers.Wallet.createRandom()
        var keystore = await unencryptedWallet.encrypt(password)
        this.wallet = new Wallet(keystore, this.options)
        return this.wallet
    }

    async import(keystore: string, password: string) {
        await ethers.Wallet.fromEncryptedJson(keystore, password)
        this.wallet = new Wallet(keystore, this.options)
        return this.wallet
    }

    async decryptWallet(keystore: string, password: string): Promise<ethers.Wallet> {
        return await ethers.Wallet.fromEncryptedJson(keystore, password)
    }

    load(keystore: string) {
        this.wallet = new Wallet(keystore, this.options)
        return this.wallet
    }

    async sendBackupMail(wallet: Wallet, email: string) {
        return this.relayAPI.post('/backupMail', {email,keystore:wallet.keystore})
    }

    async emailExists(email: string): Promise<boolean> {
        return (await this.relayAPI.post('/emailExists', {email})).data.exists
    }

    async getConfig(): Promise<object> {
        const config = (await this.relayAPI.post('/getConfig', {version:this.options.version})).data
        this.options = Object.assign(this.options, config)
        return this.options
    }

}
