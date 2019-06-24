import * as ethers from 'ethers'
import axios, { AxiosInstance } from 'axios'
import BigNumber from 'bignumber.js'

ethers.errors.setLogLevel('error')

const factoryAbi = [
    "function deployWallet(address token, address to, uint256 value) returns (address)",
    "function deployWallet(uint fee, address token, address to, uint value, uint8 v, bytes32 r, bytes32 s) returns (address)",
    "function canDeploy(address owner) view returns (bool inexistent)",
    "function getCreate2Address(address owner) view returns (address)"
]

const tokenAbi = [
    "event Transfer(address indexed src, address indexed dst, uint value)",
    "function balanceOf(address owner) view returns (uint)"
]

const smartWalletAbi = require('./ABI/SmartWallet')

export default class Wallet {

    relayAPI: AxiosInstance
    options: any
    keystore: any
    signer: string
    walletAddress: string | undefined
    factory: ethers.Contract
    provider: ethers.providers.Provider
    smartWallet: ethers.Contract | undefined
    tokenAbi: any

    constructor(keystore: any, opts: object) {
        this.options = opts
        this.keystore = typeof keystore === 'string'? JSON.parse(keystore) : keystore
        this.signer = ethers.utils.getAddress('0x'+this.keystore.address)
        this.provider = ethers.getDefaultProvider(this.options.provider)
        this.factory = new ethers.Contract(this.options.factory, factoryAbi, this.provider)
        this.relayAPI = axios.create({
            baseURL: this.options.relay,
            timeout: 30000
        });
        this.tokenAbi = (new ethers.utils.Interface(tokenAbi)).abi
    }

    async queryCreate2Address() {
        if(typeof this.walletAddress === 'string') return this.walletAddress;
        this.walletAddress = await this.factory.getCreate2Address(this.signer)
        this.smartWallet = new ethers.Contract(this.walletAddress!, smartWalletAbi, this.provider)
        return this.walletAddress;
    }

    canDeploy() {
        return this.factory.canDeploy(this.signer)
    }

    async transfer({token, decimals, to, value, wallet}: { token: string, decimals: number, to: string, value: string, wallet: ethers.Wallet }): Promise<any> {
        token = token.toUpperCase()
        await this.queryCreate2Address()

        let gaspriceInWei;
        try {
            var { gwei: gasprice, fee } = await this.calculateFee(wallet, token, to)
            fee = new BigNumber(fee).shiftedBy(decimals).toFixed()
            gaspriceInWei = ethers.utils.parseUnits(String(gasprice), 'gwei')
        } catch(e) {
            throw e
        }

        let request: any = {
            token,
            gasprice: gaspriceInWei.toString(),
            to,
            value,
            fee,
        }

        if(await this.canDeploy()) {

            const hash = ethers.utils.solidityKeccak256([
                "address",
                "address",
                "address",
                "address",
                "uint",
                "uint",
                "uint"
            ],
            [
                this.options.factory,
                this.options.relayAddress,
                this.options.tokens[token].address,
                request.to,
                request.gasprice,
                request.fee,
                request.value
            ])

            const sig = await wallet.signMessage(ethers.utils.arrayify(hash))
    
            request.sig = sig;

            return this.relayAPI.post('/deploySend', request)
        } else {

            request.nonce = ethers.utils.bigNumberify(await this.smartWallet!.store(ethers.utils.formatBytes32String("nonce"))).toString()

            var hash = ethers.utils.solidityKeccak256([
                "address",
                "address",
                "address",
                "address",
                "uint",
                "uint",
                "uint",
                "uint"
            ],
            [
                this.options.relayAddress,
                request.to,
                this.options.tokens[token].address,
                this.options.factory,
                request.value,
                request.fee,
                request.gasprice,
                request.nonce
            ])
    
            const sig = await wallet.signMessage(ethers.utils.arrayify(hash))
            
            request.sig = sig;

            return this.relayAPI.post('/send', request)
        }

    }

    async getRelayFee(token: string, estimatedGas: ethers.utils.BigNumber): Promise<{fee:string, gwei:number}> {
        token = token.toUpperCase()
        const response = await this.relayAPI.post('/calculateFee', {token, gas: estimatedGas.toString()})
        const result = {
            fee: (new BigNumber(response.data.amount)).toPrecision(),
            gwei: Number(response.data.gwei)
        }
        return result

    }
 
    async calculateFee(walletOrPassword: ethers.Wallet | string, token: string, to: string = "0x0000000000000000000000000000000000000001", value: string = "0", gas?: string): Promise<{gwei: number, gas: string, fee: string}> {
        const wallet = await this.getWallet(walletOrPassword)

        let estimatedGas = new ethers.utils.BigNumber(gas || await this.calculateGas(wallet, token, to, value));
        const {fee, gwei} = await this.getRelayFee(token, estimatedGas)
        return { gwei, gas: estimatedGas.toString(), fee}

    }

    async calculateGas(walletOrPassword: string | ethers.Wallet, token: string, to: string = "0x0000000000000000000000000000000000000001", value = "0") {
        const wallet = await this.getWallet(walletOrPassword)
        if(await this.canDeploy()) {
            return this.calcDeploySendGas(wallet, token, to, value)
        } else {
            return this.calcSendGas(wallet, token, to, value)
        }
    }

    async calcDeploySendGas(walletOrPassword: string | ethers.Wallet, token: string, to: string, value: string) {
        const wallet = await this.getWallet(walletOrPassword)
        await this.queryCreate2Address()

        var request = {
            gasprice:"0",
            to,
            token,
            value,
            fee: "0",
        }
        var hash = ethers.utils.solidityKeccak256([
            "address",
            "address",
            "address",
            "address",
            "uint",
            "uint",
            "uint"
        ],
        [
            this.options.factory,
            this.options.relayAddress,
            this.options.tokens[token].address,
            request.to,
            request.gasprice,
            request.fee,
            request.value
        ])

        var sig = ethers.utils.splitSignature(await wallet.signMessage(ethers.utils.arrayify(hash)))
        return this.factory.estimate["deployWallet(uint256,address,address,uint256,uint8,bytes32,bytes32)"](request.fee, this.options.tokens[token].address, request.to, request.value, sig.v, sig.r, sig.s, {from: this.options.relayAddress, gasPrice:ethers.utils.parseUnits(request.gasprice, 'wei')})
    }

    async calcSendGas(walletOrPassword: string | ethers.Wallet, token: string, to: string, value: string) {
        const wallet = await this.getWallet(walletOrPassword)
        await this.queryCreate2Address()

        var request = {
            gasprice:"0",
            to,
            value,
            nonce: ethers.utils.bigNumberify(await this.smartWallet!.store(ethers.utils.formatBytes32String("nonce"))).toString(),
            fee: "0", 
            token
        }
        var hash = ethers.utils.solidityKeccak256([
            "address",
            "address",
            "address",
            "address",
            "uint",
            "uint",
            "uint",
            "uint"
        ],
        [
            this.options.relayAddress,
            request.to,
            this.options.tokens[token].address,
            this.options.factory,
            request.value,
            request.fee,
            request.gasprice,
            request.nonce,
        ])
        var sig = ethers.utils.splitSignature(await wallet.signMessage(ethers.utils.arrayify(hash)))

        return this.smartWallet!.estimate['pay(address,uint256,uint256,address,uint8,bytes32,bytes32)'](request.to, request.value, request.fee, this.options.tokens[token].address, sig.v, sig.r, sig.s, {from:this.options.relayAddress, gasPrice:ethers.utils.parseUnits(request.gasprice, 'wei')})

    }

    async estimateDirectTransfer(walletOrPassword: string | ethers.Wallet, token: string, to: string = "0x0000000000000000000000000000000000000001", value: string = "0", canDeploy?: boolean): Promise<string> {
        await this.queryCreate2Address()
        const wallet = await this.getWallet(walletOrPassword)
        if(typeof canDeploy === 'undefined') {
            canDeploy = await this.canDeploy()
        }
        if(canDeploy) {
            const factory = new ethers.Contract(this.options.factory, factoryAbi, wallet)
            return (await factory.estimate["deployWallet(address,address,uint256)"](this.options.tokens[token].address, to, value)).toString()
        } else {
            const smartWallet = new ethers.Contract(this.walletAddress!, smartWalletAbi, wallet)
            return (await smartWallet.estimate["pay(address,uint256,address)"](to, value, this.options.tokens[token].address)).toString()
        }
    }

    async directTransfer({walletOrPassword, token, to, value, gwei, gas}: {token: string, to: string, gwei: number, value: string, walletOrPassword: ethers.Wallet | string, gas?: string }) {
        const wallet = await this.getWallet(walletOrPassword)
        const canDeploy = await this.canDeploy()
        if(typeof gas === 'undefined') {
            gas = await this.estimateDirectTransfer(wallet, token, to, value, canDeploy)
        }
        await this.queryCreate2Address()
        
        if(canDeploy) {
            const factory = new ethers.Contract(this.options.factory, factoryAbi, wallet)
            return await factory.functions["deployWallet(address,address,uint256)"](this.options.tokens[token].address, to, value, {gasPrice:ethers.utils.parseUnits(String(gwei), 'gwei')})
        } else {
            const smartWallet = new ethers.Contract(this.walletAddress!, smartWalletAbi, wallet)
            return await smartWallet.functions["pay(address,uint256,address)"](to, value, this.options.tokens[token].address, {gasPrice:ethers.utils.parseUnits(String(gwei), 'gwei')})
        }
    }

    async getWallet(walletOrPassword: string | ethers.Wallet): Promise<ethers.Wallet> {
        if(typeof walletOrPassword === 'string') {
            try {
                return (await ethers.Wallet.fromEncryptedJson(JSON.stringify(this.keystore), walletOrPassword)).connect(this.provider)
            } catch(e) {
                throw "Incorrect password"
            }
        } else {
            walletOrPassword = walletOrPassword.connect(this.provider)
            return walletOrPassword
        }
    }

    async estimateTransferEth(to: string = "0x0000000000000000000000000000000000000001", value: string = "0"): Promise<string> {
        return (await this.provider.estimateGas({
            from: this.signer,
            to,
            value
        })).toString()
    }

    async transferEth({walletOrPassword, to, value, gas, gwei}: {to: string, value: string, walletOrPassword: string | ethers.Wallet, gas:number, gwei:number}): Promise<ethers.providers.TransactionResponse> {
        const wallet = await this.getWallet(walletOrPassword)
        return await wallet.sendTransaction({
            to,
            value,
            gasLimit: gas,
            gasPrice: gwei
        })
    }

    async getTokenBalance(address: string): Promise<string> {
        await this.queryCreate2Address();
        let tokenContract = new ethers.Contract(address, tokenAbi, this.provider)
        let balance = await tokenContract.balanceOf(this.walletAddress)
        return balance.toString()
    }

    async getEthBalance(): Promise<string> {
        const balance = await this.provider.getBalance(this.signer)
        return balance.toString()
    }

}