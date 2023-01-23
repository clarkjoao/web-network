import { Bounty } from "@taikai/dappkit/dist/src";
import {withCors} from "middleware";
import {NextApiRequest, NextApiResponse} from "next";
import {Op} from "sequelize";

import models from "db/models";

import { formatNumberToNScale } from "helpers/formatNumber";
import {Settings} from "helpers/settings";

import DAO from "services/dao-service";
import ipfsService from "services/ipfs-service";
import {error as LogError} from "services/logging";

interface NftPayload { 
  issueContractId: number;
  proposalContractId: number;
  networkName: string;
  mergerAddress: string;
}

async function post(req: NextApiRequest, res: NextApiResponse) {
  try{
    const {
      issueContractId,
      proposalContractId,
      networkName
    } = req.body as NftPayload;
    
    if(!networkName || proposalContractId < 0 || issueContractId < 0)
      return res.status(400).json("Missing parameters");
    
    const settings = await models.settings.findAll({
    where: { 
      visibility: "public",
      group: "urls"
    },
    raw: true,
    });

    const defaultConfig = (new Settings(settings)).raw();
  
    if (!defaultConfig?.urls?.ipfs)
      return res.status(500).json("Missing ipfs url on settings");

    const customNetwork = await models.network.findOne({
        where: {
          name: {
            [Op.iLike]: String(networkName).replaceAll(" ", "-")
          }
        }
    });
    
    if(!customNetwork)
      return res.status(404).json('Network not founded');

    const DAOService = new DAO({ 
      skipWindowAssignment: true,
      web3Host: defaultConfig.urls.web3Provider,
    });

    if (!await DAOService.start()) return res.status(500).json("Failed to connect with chain");
    if(!await DAOService.loadNetwork(customNetwork.networkAddress)) 
      return res.status(500).json("network could not be loaded");

    const network = DAOService.network;

    await network.start();

    const networkBounty = await network.getBounty(issueContractId) as Bounty;
    if (!networkBounty) return res.status(404).json("Bounty invalid");

    if(networkBounty.canceled || networkBounty.closed)
      return res.status(404).json("Bounty has been closed or canceled");

    const proposal = networkBounty.proposals.find(p=> p.id === +proposalContractId)
    
    if(!proposal)
      return res.status(404).json("Proposal invalid");

    if(proposal.refusedByBountyOwner || await network.isProposalDisputed(+issueContractId, +proposalContractId))
      return res.status(404).json("proposal cannot be accepted");

    const pullRequest = networkBounty.pullRequests.find(pr=> pr.id === proposal.prId)

    if(pullRequest.canceled || !pullRequest.ready)
      return res.status(404).json("PR cannot be accepted");

    const issue = await models.issue.findOne({
      where: {
        issueId: networkBounty?.cid,
        network_id: customNetwork?.id
      },
    });

    const token = await DAOService.getERC20TokenData(networkBounty.transactional);

    const formattedTokenAmount = `${formatNumberToNScale(networkBounty.tokenAmount)} ${token.symbol}`;
    
    const nft = {
      name: `BEPRO Bounty ${issue.githubId} - ${networkBounty.title}`,
      description: `Created on ${customNetwork.name} awarded along with ${formattedTokenAmount}`,
      image: issue.seoImage? `${defaultConfig.urls.ipfs}/${issue.seoImage}`: ""
    }

    const { hash } = await ipfsService.add(nft, true);

    if(!hash) return res.status(500);

    const url = `${defaultConfig.urls.ipfs}/${hash}`;
 
    return res.status(200).json({url});
  }
  catch(error){
    LogError(error)
    return res.status(500).send(error);
  }
}

async function NftMethods(req: NextApiRequest, res: NextApiResponse) {
  switch (req.method.toLowerCase()) {
  case "post":
    await post(req, res);
    break;

  default:
    res.status(405).json("Method not allowed");
  }

  res.end();
}

export default withCors(NftMethods);