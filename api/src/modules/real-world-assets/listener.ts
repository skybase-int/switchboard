import { Prisma, RWAPortfolio } from "@prisma/client";
import { InternalTransmitterUpdate, OperationUpdate } from "document-drive";
import { AddFileInput, DeleteNodeInput, DocumentDriveDocument, DocumentDriveState, ListenerFilter } from "document-model-libs/document-drive";
import { AddFeeTransactionsToGroupTransactionInput, CreateAccountInput, CreateAssetPurchaseGroupTransactionInput, CreateAssetSaleGroupTransactionInput, CreateCashAssetInput, CreateFeesPaymentGroupTransactionInput, CreateFixedIncomeAssetInput, CreateFixedIncomeTypeInput, CreateInterestReturnGroupTransactionInput, CreatePrincipalDrawGroupTransactionInput, CreatePrincipalReturnGroupTransactionInput, CreateServiceProviderInput, CreateSpvInput, DeleteAccountInput, DeleteGroupTransactionInput, DeleteServiceProviderInput, DeleteSpvInput, EditAccountInput, EditAssetPurchaseGroupTransactionInput, EditAssetSaleGroupTransactionInput, EditCashAssetInput, EditFeeTransactionInput, EditFixedIncomeAssetInput, EditFixedIncomeTypeInput, EditGroupTransactionTypeInput, EditInterestDrawGroupTransactionInput, EditInterestReturnGroupTransactionInput, EditPrincipalDrawGroupTransactionInput, EditPrincipalReturnGroupTransactionInput, EditServiceProviderInput, EditSpvInput, RealWorldAssetsDocument, RealWorldAssetsState, RemoveFeeTransactionFromGroupTransactionInput, isCashAsset, utils, AssetPurchaseGroupTransaction, PrincipalDrawGroupTransaction, PrincipalReturnGroupTransaction, AssetSaleGroupTransaction, InterestDrawGroupTransaction, FeesPaymentGroupTransaction, InterestReturnGroupTransaction } from "document-model-libs/real-world-assets"
import { getChildLogger } from "../../logger";

const logger = getChildLogger({ msgPrefix: 'RWA Internal Listener' }, { moduleName: "RWA Internal Listener" });

export interface IReceiverOptions {
    listenerId: string;
    label: string;
    block: boolean;
    filter: ListenerFilter;
}

export const listener: IReceiverOptions = {
    listenerId: "real-world-assets",
    filter: {
        branch: ["main"],
        documentId: ["*"],
        documentType: ["makerdao/rwa-portfolio", "powerhouse/document-drive"],
        scope: ["*"],
    },
    block: false,
    label: "real-world-assets",
}


export async function transmit(strands: InternalTransmitterUpdate<RealWorldAssetsDocument | DocumentDriveDocument, "global">[], prisma: Prisma.TransactionClient) {
    // logger.debug(strands);
    for (const strand of strands) {

        if (strand.documentId === "") {
            await handleDriveStrand(strand as InternalTransmitterUpdate<DocumentDriveDocument, "global">, prisma);
        } else {
            await handleRwaDocumentStrand(strand as InternalTransmitterUpdate<RealWorldAssetsDocument, "global">, prisma);
        }
    }
}

async function handleDriveStrand(strand: InternalTransmitterUpdate<DocumentDriveDocument, "global">, prisma: Prisma.TransactionClient) {
    logger.debug("Received strand for drive");
    if (strandStartsFromOpZero(strand)) {
        await deleteDriveState(strand.state, prisma);
    }

    await doSurgicalDriveUpdate(strand, prisma);
}

function strandStartsFromOpZero(strand: InternalTransmitterUpdate<DocumentDriveDocument | RealWorldAssetsDocument, "global">) {
    const resetNeeded = strand.operations.length > 0
        && (
            strand.operations[0].index === 0
            || strand.operations[strand.operations.length].index - strand.operations[strand.operations.length].skip === 0
        );
    logger.debug(`Reset needed: ${resetNeeded}`);
    return resetNeeded;
}
async function doSurgicalDriveUpdate(strand: InternalTransmitterUpdate<DocumentDriveDocument, "global">, prisma: Prisma.TransactionClient) {
    logger.debug("Doing surgical drive update");
    for (const operation of strand.operations) {
        logger.debug(`Operation: ${operation.type}`);
        switch (operation.type) {
            case "ADD_FILE":
                const addFileInput = operation.input as AddFileInput;
                if (addFileInput.documentType === "makerdao/rwa-portfolio") {
                    logger.debug({ msg: `Adding ${addFileInput.documentType}`, operation });
                    const document = utils.createDocument(addFileInput);
                    await rebuildRwaPortfolio(strand.driveId, addFileInput.id, document.state.global, prisma);
                }
                break;
            case "DELETE_NODE":
                const deleteNodeInput = operation.input as DeleteNodeInput;
                const driveId = strand.driveId;
                logger.debug(`Removing file ${deleteNodeInput.id} from ${driveId}`);
                const result = await prisma.rWAPortfolio.deleteMany({
                    where: {
                        AND: {
                            documentId: deleteNodeInput.id,
                            driveId
                        }
                    }
                })
                logger.debug(`Removed ${result.count} portfolios`);
                break;
            default:
                logger.debug(`Ignoring operation ${operation.type}`);
                break;
        }
    }
}

async function deleteDriveState(state: DocumentDriveState, prisma: Prisma.TransactionClient) {
    logger.debug("Deleting rwa read model");
    await prisma.rWAPortfolio.deleteMany({
        where: {
            driveId: state.id
        }
    });
}

async function rebuildRwaPortfolio(driveId: string, documentId: string, state: RealWorldAssetsState, prisma: Prisma.TransactionClient) {
    const { transactions, principalLenderAccountId, fixedIncomeTypes, spvs, accounts, feeTypes, portfolio } = state;
    // create portfolio document
    const portfolioEntity = await prisma.rWAPortfolio.upsert({
        where: {
            driveId_documentId: {
                documentId,
                driveId
            }
        },
        create: {
            documentId,
            driveId,
            principalLenderAccountId: principalLenderAccountId,
        },
        update: {
            principalLenderAccountId: principalLenderAccountId,
        },
    });

    // create spvs
    await prisma.rWAPortfolioSpv.createMany({
        data: spvs.map((spv) => ({ ...spv, portfolioId: portfolioEntity.id })),
        skipDuplicates: true,
    });

    // create feeTypes
    await prisma.rWAPortfolioServiceProvider.createMany({
        data: feeTypes.map((feeType) => ({ ...feeType, portfolioId: portfolioEntity.id })),
        skipDuplicates: true,
    });

    // fixed income types
    await prisma.rWAPortfolioFixedIncomeType.createMany({
        data: fixedIncomeTypes.map((fixedIncomeType) => ({ ...fixedIncomeType, portfolioId: portfolioEntity.id })),
        skipDuplicates: true,
    });

    // create accounts
    await prisma.rWAPortfolioAccount.createMany({
        data: accounts.map((account) => ({ ...account, portfolioId: portfolioEntity.id })),
        skipDuplicates: true,
    });

    // create RWAPortfolioAsset
    await prisma.rWAPortfolioAsset.createMany({
        data: portfolio.map((asset) => ({ ...asset, assetRefId: asset.id, portfolioId: portfolioEntity.id, assetType: utils.isCashAsset(asset) ? "Cash" : "FixedIncome" })),
        skipDuplicates: true,
    });

    // create transactions
    for (const transaction of transactions) {
        let cashTxEntity;
        let feeTxEntities = [];
        let interestTxEntity;
        let fixedIncomeTxEntity;
        if (transaction.type === "PrincipalDraw") {
            const tx = transaction as PrincipalDrawGroupTransaction;
            // cash transaction
            if (tx.cashTransaction) {
                cashTxEntity = await prisma.rWABaseTransaction.create({
                    data: {
                        ...tx.cashTransaction,
                        portfolioId: portfolioEntity.id,
                    }
                });
            }
            // fee transactions
            for (const feeTx of tx.feeTransactions ?? []) {
                feeTxEntities.push(await prisma.rWABaseTransaction.create({
                    data: {
                        ...feeTx,
                        portfolioId: portfolioEntity.id,
                    }
                }));
            }
        } else if (transaction.type === "PrincipalReturn") {
            const tx = transaction as PrincipalReturnGroupTransaction;
            // cash transaction

            if (tx.cashTransaction) {
                cashTxEntity = await prisma.rWABaseTransaction.create({
                    data: {
                        ...tx.cashTransaction,
                        portfolioId: portfolioEntity.id,
                    }
                });
            }
            // fee transactions
            for (const feeTx of tx.feeTransactions ?? []) {
                feeTxEntities.push(await prisma.rWABaseTransaction.create({
                    data: {
                        ...feeTx,
                        portfolioId: portfolioEntity.id,
                    }
                }));
            }
        } else if (transaction.type === "AssetPurchase") {
            const tx = transaction as AssetPurchaseGroupTransaction;
            // cash transaction
            if (tx.cashTransaction) {
                cashTxEntity = await prisma.rWABaseTransaction.create({
                    data: {
                        ...tx.cashTransaction,
                        portfolioId: portfolioEntity.id,
                    }
                });
            }
            // fee transactions
            for (const feeTx of tx.feeTransactions ?? []) {
                feeTxEntities.push(await prisma.rWABaseTransaction.create({
                    data: {
                        ...feeTx,
                        portfolioId: portfolioEntity.id,
                    }
                }));
            }
            // fixed income transaction
            if (tx.fixedIncomeTransaction) {
                fixedIncomeTxEntity = await prisma.rWABaseTransaction.create({
                    data: {
                        ...tx.fixedIncomeTransaction,
                        portfolioId: portfolioEntity.id,
                    }
                });
            }
        } else if (transaction.type === "AssetSale") {
            const tx = transaction as AssetSaleGroupTransaction;
            // cash transaction
            if (tx.cashTransaction) {
                cashTxEntity = await prisma.rWABaseTransaction.create({
                    data: {
                        ...tx.cashTransaction,
                        portfolioId: portfolioEntity.id,
                    }
                });
            }
            // fee transactions
            for (const feeTx of tx.feeTransactions ?? []) {
                feeTxEntities.push(await prisma.rWABaseTransaction.create({
                    data: {
                        ...feeTx,
                        portfolioId: portfolioEntity.id,
                    }
                }));
            }
            // fixed income transaction
            if (tx.fixedIncomeTransaction) {
                fixedIncomeTxEntity = await prisma.rWABaseTransaction.create({
                    data: {
                        ...tx.fixedIncomeTransaction,
                        portfolioId: portfolioEntity.id,
                    }
                });
            }
        } else if (transaction.type === "InterestDraw") {
            const tx = transaction as InterestDrawGroupTransaction;
            // interest transaction
            if (tx.interestTransaction) {
                interestTxEntity = await prisma.rWABaseTransaction.create({
                    data: {
                        ...tx.interestTransaction,
                        portfolioId: portfolioEntity.id,
                    }
                });
            }
        } else if (transaction.type === "FeesPayment") {
            const tx = transaction as FeesPaymentGroupTransaction;
            // fee transactions
            for (const feeTx of tx.feeTransactions ?? []) {
                feeTxEntities.push(await prisma.rWABaseTransaction.create({
                    data: {
                        ...feeTx,
                        portfolioId: portfolioEntity.id,
                    }
                }));
            }
        } else if (transaction.type === "InterestReturn") {
            const tx = transaction as InterestReturnGroupTransaction;
            // interest transaction
            if (tx.interestTransaction) {
                interestTxEntity = await prisma.rWABaseTransaction.create({
                    data: {
                        ...tx.interestTransaction,
                        portfolioId: portfolioEntity.id,
                    }
                });
            }
        }

        // Create Grpup TX Entity
        const groupTxEntity = await prisma.rWAGroupTransaction.create({
            data: {
                id: transaction.id,
                portfolioId: portfolioEntity.id,
                type: transaction.type,
                cashTransactionId: cashTxEntity?.id ?? undefined,
                fixedTransactionId: fixedIncomeTxEntity?.id ?? undefined,
                interestTransactionId: interestTxEntity?.id ?? undefined,
            },
        })

        // add relationships for fees
        for (const feeTxEntity of feeTxEntities) {
            await prisma.rWABaseTransactionOnGroupTransaction.create({
                data: {
                    portfolioId: portfolioEntity.id,
                    baseTransactionId: feeTxEntity.id,
                    groupTransactionId: groupTxEntity.id,
                }
            });
        }
    }

    // add relationships
    await prisma.rWAPortfolioFixedIncomeTypeOnPortfolio.createMany({
        data: fixedIncomeTypes.map((fixedIncomeType) => ({
            fixedIncomeTypeId: fixedIncomeType.id,
            portfolioId: portfolioEntity.id,
        })),
        skipDuplicates: true,
    });

    await prisma.rWAPortfolioServiceProviderOnPortfolio.createMany({
        data: feeTypes.map((feeType) => ({ portfolioId: portfolioEntity.id, spvId: feeType.id })),
        skipDuplicates: true,
    });

    await prisma.rWAPortfolioSpvOnPortfolio.createMany({
        data: spvs.map((spv) => ({ portfolioId: portfolioEntity.id, spvId: spv.id })),
        skipDuplicates: true,
    });

    await prisma.rWAAccountOnPortfolio.createMany({
        data: accounts.map((account) => ({ portfolioId: portfolioEntity.id, accountId: account.id })),
        skipDuplicates: true,
    });

}

async function rwaPortfolioExists(driveId: string, documentId: string, prisma: Prisma.TransactionClient) {
    const portfolio = await prisma.rWAPortfolio.findFirst({
        where: {
            driveId,
            documentId
        }
    });

    return !!portfolio;
}

const surgicalOperations: Record<string, (input: any, portfolio: RWAPortfolio, prisma: Prisma.TransactionClient) => Promise<void>> = {
    "CREATE_FIXED_INCOME_ASSET": async (input: CreateFixedIncomeAssetInput, portfolio: RWAPortfolio, prisma: Prisma.TransactionClient) => {
        logger.debug({ msg: "Creating fixed income asset", input });
        await prisma.rWAPortfolioAsset.create({
            data: {
                ...input,
                assetRefId: input.id,
                portfolioId: portfolio.id,
                assetType: "FixedIncome"
            }

        });


    },
    "EDIT_FIXED_INCOME_ASSET": async (input: EditFixedIncomeAssetInput, portfolio: RWAPortfolio, prisma: Prisma.TransactionClient) => {
        logger.debug({ msg: "Editing fixed income asset", input });
        await prisma.rWAPortfolioAsset.update({
            where: {
                assetRefId_portfolioId: {
                    assetRefId: input.id,
                    portfolioId: portfolio.id
                }
            },
            data: {
                ...input,
            }
        });
    },
    "CREATE_SPV": async (input: CreateSpvInput, portfolio: RWAPortfolio, prisma: Prisma.TransactionClient) => {
        logger.debug({ msg: "Creating SPV", input });
        await prisma.rWAPortfolioSpv.create({
            data: {
                ...input,
                portfolioId: portfolio.id
            }
        });
    },
    "EDIT_SPV": async (input: EditSpvInput, portfolio: RWAPortfolio, prisma: Prisma.TransactionClient) => {
        logger.debug({ msg: "Editing SPV", input });
        await prisma.rWAPortfolioSpv.update({
            where: {
                id_portfolioId: {
                    id: input.id,
                    portfolioId: portfolio.id
                }
            },
            data: {
                ...input,
            }
        });
    },
    "DELETE_SPV": async (input: DeleteSpvInput, portfolio: RWAPortfolio, prisma: Prisma.TransactionClient) => {
        logger.debug({ msg: "Deleting SPV", input });
        await prisma.rWAPortfolioSpv.delete({
            where: {
                id_portfolioId: {
                    id: input.id,
                    portfolioId: portfolio.id
                }
            }
        });
    },
    "CREATE_SERVICE_PROVIDER": async (input: CreateServiceProviderInput, portfolio: RWAPortfolio, prisma: Prisma.TransactionClient) => {
        logger.debug({ msg: "Creating service provider", input });
        await prisma.rWAPortfolioServiceProvider.create({
            data: {
                ...input,
                portfolioId: portfolio.id
            }
        });
    },
    "EDIT_SERVICE_PROVIDER": async (input: EditServiceProviderInput, portfolio: RWAPortfolio, prisma: Prisma.TransactionClient) => {
        logger.debug({ msg: "Editing service provider", input });
        await prisma.rWAPortfolioServiceProvider.update({
            where: {
                id_portfolioId: {
                    id: input.id,
                    portfolioId: portfolio.id
                }
            },
            data: {
                ...input,
                accountId: input.accountId ?? undefined,
                name: input.name ?? undefined,
                feeType: input.feeType ?? undefined,
            }
        });
    },
    "DELETE_SERVICE_PROVIDER": async (input: DeleteServiceProviderInput, portfolio: RWAPortfolio, prisma: Prisma.TransactionClient) => {
        logger.debug({ msg: "Deleting service provider", input });
        await prisma.rWAPortfolioServiceProvider.delete({
            where: {
                id_portfolioId: {
                    id: input.id,
                    portfolioId: portfolio.id
                }
            }
        });
    },
    "CREATE_ACCOUNT": async (input: CreateAccountInput, portfolio: RWAPortfolio, prisma: Prisma.TransactionClient) => {
        logger.debug({ msg: "Creating account", input });
        await prisma.rWAPortfolioAccount.create({
            data: {
                ...input,
                portfolioId: portfolio.id
            }
        });
    },
    "EDIT_ACCOUNT": async (input: EditAccountInput, portfolio: RWAPortfolio, prisma: Prisma.TransactionClient) => {
        logger.debug({ msg: "Editing account", input });
        await prisma.rWAPortfolioAccount.update({
            where: {
                id_portfolioId: {
                    id: input.id,
                    portfolioId: portfolio.id
                }
            },
            data: {
                ...input,
                reference: input.reference ?? undefined,
            }
        });
    },
    "DELETE_ACCOUNT": async (input: DeleteAccountInput, portfolio: RWAPortfolio, prisma: Prisma.TransactionClient) => {
        logger.debug({ msg: "Deleting account", input });
        await prisma.rWAPortfolioAccount.delete({
            where: {
                id_portfolioId: {
                    id: input.id,
                    portfolioId: portfolio.id
                }
            }
        });
    },
    "CREATE_FIXED_INCOME_TYPE": async (input: CreateFixedIncomeTypeInput, portfolio: RWAPortfolio, prisma: Prisma.TransactionClient) => {
        logger.debug({ msg: "Creating fixed income type", input });
        await prisma.rWAPortfolioFixedIncomeType.create({
            data: {
                ...input,
                portfolioId: portfolio.id
            }
        });
    },
    "EDIT_FIXED_INCOME_TYPE": async (input: EditFixedIncomeTypeInput, portfolio: RWAPortfolio, prisma: Prisma.TransactionClient) => {
        logger.debug({ msg: "Editing fixed income type", input });
        await prisma.rWAPortfolioFixedIncomeType.update({
            where: {
                id_portfolioId: {
                    id: input.id,
                    portfolioId: portfolio.id
                }
            },
            data: {
                ...input,
                name: input.name ?? undefined,
            }
        });
    },
    "CREATE_CASH_ASSET": async (input: CreateCashAssetInput, portfolio: RWAPortfolio, prisma: Prisma.TransactionClient) => {
        logger.debug({ msg: "Creating cash asset", input });
        await prisma.rWAPortfolioAsset.create({
            data: {
                ...input,
                assetRefId: input.id,
                portfolioId: portfolio.id,
                assetType: "Cash"
            }
        });
    },
    "EDIT_CASH_ASSET": async (input: EditCashAssetInput, portfolio: RWAPortfolio, prisma: Prisma.TransactionClient) => {
        logger.debug({ msg: "Editing cash asset", input });
        await prisma.rWAPortfolioAsset.update({
            where: {
                assetRefId_portfolioId: {
                    assetRefId: input.id,
                    portfolioId: portfolio.id
                }
            },
            data: {
                ...input,
            }
        });
    },
    "CREATE_PRINCIPAL_DRAW_GROUP_TRANSACTION": async (input: CreatePrincipalDrawGroupTransactionInput, portfolio: RWAPortfolio, prisma: Prisma.TransactionClient) => {
        logger.debug({ msg: "Creating principal draw transaction", input });
        const { id } = await prisma.rWAGroupTransaction.create({
            data: {
                id: input.id,
                portfolioId: portfolio.id,
                type: "PrincipalDraw",
            }
        });

        for (const feeTx of input.feeTransactions ?? []) {
            const feeTxEntity = await prisma.rWABaseTransaction.create({
                data: {
                    ...feeTx,
                    portfolioId: portfolio.id,
                }
            });

            await prisma.rWABaseTransactionOnGroupTransaction.create({
                data: {
                    portfolioId: portfolio.id,
                    baseTransactionId: feeTxEntity.id,
                    groupTransactionId: id,
                }
            });
        }

        if (input.cashTransaction) {
            const cashTxEntity = await prisma.rWABaseTransaction.create({
                data: {
                    ...input.cashTransaction,
                    portfolioId: portfolio.id,
                }
            });

            await prisma.rWABaseTransactionOnGroupTransaction.create({
                data: {
                    portfolioId: portfolio.id,
                    baseTransactionId: cashTxEntity.id,
                    groupTransactionId: id,
                }
            });

        }
    },
    "CREATE_PRINCIPAL_RETURN_GROUP_TRANSACTION": async (input: CreatePrincipalReturnGroupTransactionInput, portfolio: RWAPortfolio, prisma: Prisma.TransactionClient) => {
        logger.debug({ msg: "Creating principal return transaction", input });
        const { id } = await prisma.rWAGroupTransaction.create({
            data: {
                id: input.id,
                portfolioId: portfolio.id,
                type: "PrincipalReturn",
            }
        });

        for (const feeTx of input.feeTransactions ?? []) {
            const feeTxEntity = await prisma.rWABaseTransaction.create({
                data: {
                    ...feeTx,
                    portfolioId: portfolio.id,
                }
            });

            await prisma.rWABaseTransactionOnGroupTransaction.create({
                data: {
                    portfolioId: portfolio.id,
                    baseTransactionId: feeTxEntity.id,
                    groupTransactionId: id,
                }
            });
        }

        if (input.cashTransaction) {
            const cashTxEntity = await prisma.rWABaseTransaction.create({
                data: {
                    ...input.cashTransaction,
                    portfolioId: portfolio.id,
                }
            });

            await prisma.rWABaseTransactionOnGroupTransaction.create({
                data: {
                    portfolioId: portfolio.id,
                    baseTransactionId: cashTxEntity.id,
                    groupTransactionId: id,
                }
            });

        }
    },
    "CREATE_ASSET_PURCHASE_GROUP_TRANSACTION": async (input: CreateAssetPurchaseGroupTransactionInput, portfolio: RWAPortfolio, prisma: Prisma.TransactionClient) => {
        logger.debug({ msg: "Creating asset purchase transaction", input });
        const { id } = await prisma.rWAGroupTransaction.create({
            data: {
                id: input.id,
                portfolioId: portfolio.id,
                type: "AssetPurchase",
            }
        });

        for (const feeTx of input.feeTransactions ?? []) {
            const feeTxEntity = await prisma.rWABaseTransaction.create({
                data: {
                    ...feeTx,
                    portfolioId: portfolio.id,
                }
            });

            await prisma.rWABaseTransactionOnGroupTransaction.create({
                data: {
                    portfolioId: portfolio.id,
                    baseTransactionId: feeTxEntity.id,
                    groupTransactionId: id,
                }
            });
        }

        if (input.cashTransaction) {
            const cashTxEntity = await prisma.rWABaseTransaction.create({
                data: {
                    ...input.cashTransaction,
                    portfolioId: portfolio.id,
                }
            });

            await prisma.rWABaseTransactionOnGroupTransaction.create({
                data: {
                    portfolioId: portfolio.id,
                    baseTransactionId: cashTxEntity.id,
                    groupTransactionId: id,
                }
            });

        }
    },
    "CREATE_ASSET_SALE_GROUP_TRANSACTION": async (input: CreateAssetSaleGroupTransactionInput, portfolio: RWAPortfolio, prisma: Prisma.TransactionClient) => {
        logger.debug({ msg: "Creating asset sale transaction", input });
        const { id } = await prisma.rWAGroupTransaction.create({
            data: {
                id: input.id,
                portfolioId: portfolio.id,
                type: "AssetSale",
            }
        });

        for (const feeTx of input.feeTransactions ?? []) {
            const feeTxEntity = await prisma.rWABaseTransaction.create({
                data: {
                    ...feeTx,
                    portfolioId: portfolio.id,
                }
            });

            await prisma.rWABaseTransactionOnGroupTransaction.create({
                data: {
                    portfolioId: portfolio.id,
                    baseTransactionId: feeTxEntity.id,
                    groupTransactionId: id,
                }
            });
        }

        if (input.cashTransaction) {
            const cashTxEntity = await prisma.rWABaseTransaction.create({
                data: {
                    ...input.cashTransaction,
                    portfolioId: portfolio.id,
                }
            });

            await prisma.rWABaseTransactionOnGroupTransaction.create({
                data: {
                    portfolioId: portfolio.id,
                    baseTransactionId: cashTxEntity.id,
                    groupTransactionId: id,
                }
            });

        }
    },
    "CREATE_INTEREST_DRAW_GROUP_TRANSACTION": async (input: CreatePrincipalDrawGroupTransactionInput, portfolio: RWAPortfolio, prisma: Prisma.TransactionClient) => {
        logger.debug({ msg: "Creating interest draw transaction", input });
        const { id } = await prisma.rWAGroupTransaction.create({
            data: {
                id: input.id,
                portfolioId: portfolio.id,
                type: "InterestDraw",
            }
        });

        for (const feeTx of input.feeTransactions ?? []) {
            const feeTxEntity = await prisma.rWABaseTransaction.create({
                data: {
                    ...feeTx,
                    portfolioId: portfolio.id,
                }
            });

            await prisma.rWABaseTransactionOnGroupTransaction.create({
                data: {
                    portfolioId: portfolio.id,
                    baseTransactionId: feeTxEntity.id,
                    groupTransactionId: id,
                }
            });
        }

        if (input.cashTransaction) {
            const cashTxEntity = await prisma.rWABaseTransaction.create({
                data: {
                    ...input.cashTransaction,
                    portfolioId: portfolio.id,
                }
            });

            await prisma.rWABaseTransactionOnGroupTransaction.create({
                data: {
                    portfolioId: portfolio.id,
                    baseTransactionId: cashTxEntity.id,
                    groupTransactionId: id,
                }
            });

        }
    },
    "CREATE_INTEREST_RETURN_GROUP_TRANSACTION": async (input: CreateInterestReturnGroupTransactionInput, portfolio: RWAPortfolio, prisma: Prisma.TransactionClient) => {
        logger.debug({ msg: "Creating interest return transaction", input });
        const { id } = await prisma.rWAGroupTransaction.create({
            data: {
                id: input.id,
                portfolioId: portfolio.id,
                type: "InterestReturn",
            }
        });

        if (input.interestTransaction) {
            const interestTxEntity = await prisma.rWABaseTransaction.create({
                data: {
                    ...input.interestTransaction,
                    portfolioId: portfolio.id,
                }
            });

            await prisma.rWABaseTransactionOnGroupTransaction.create({
                data: {
                    portfolioId: portfolio.id,
                    baseTransactionId: interestTxEntity.id,
                    groupTransactionId: id,
                }
            });
        }
    },
    "CREATE_FEES_PAYMENT_GROUP_TRANSACTION": async (input: CreateFeesPaymentGroupTransactionInput, portfolio: RWAPortfolio, prisma: Prisma.TransactionClient) => {
        logger.debug({ msg: "Creating fees payment transaction", input });
        const { id } = await prisma.rWAGroupTransaction.create({
            data: {
                id: input.id,
                portfolioId: portfolio.id,
                type: "FeesPayment",
            }
        });

        for (const feeTx of input.feeTransactions ?? []) {
            const feeTxEntity = await prisma.rWABaseTransaction.create({
                data: {
                    ...feeTx,
                    portfolioId: portfolio.id,
                }
            });

            await prisma.rWABaseTransactionOnGroupTransaction.create({
                data: {
                    portfolioId: portfolio.id,
                    baseTransactionId: feeTxEntity.id,
                    groupTransactionId: id,
                }
            });
        }
    },
    "EDIT_GROUP_TRANSACTION_TYPE": async (input: EditGroupTransactionTypeInput, portfolio: RWAPortfolio, prisma: Prisma.TransactionClient) => {
        logger.debug({ msg: "Editing group transaction type", input });
        await prisma.rWAGroupTransaction.update({
            where: {
                id_portfolioId: {
                    id: input.id,
                    portfolioId: portfolio.id
                }
            },
            data: {
                type: input.type,
            }
        });
    },
    "EDIT_PRINCIPAL_DRAW_GROUP_TRANSACTION": async (input: EditPrincipalDrawGroupTransactionInput, portfolio: RWAPortfolio, prisma: Prisma.TransactionClient) => {
        logger.debug({ msg: "Editing principal draw transaction", input });
        await prisma.rWAGroupTransaction.update({
            where: {
                id_portfolioId: {
                    id: input.id,
                    portfolioId: portfolio.id
                }
            },
            data: {
                type: "PrincipalDraw",
            }
        });

        for (const feeTx of input.feeTransactions ?? []) {
            await prisma.rWABaseTransaction.update({
                where: {
                    id_portfolioId: {
                        id: input.id,
                        portfolioId: portfolio.id
                    }
                },
                data: {
                    ...feeTx,
                    portfolioId: portfolio.id,
                }
            });
        }

        if (input.cashTransaction) {
            await prisma.rWABaseTransaction.update({
                where: {
                    id_portfolioId: {
                        id: input.cashTransaction.id,
                        portfolioId: portfolio.id
                    }
                },
                data: {
                    ...input.cashTransaction,
                    portfolioId: portfolio.id,
                }
            });

        }
    },
    "EDIT_PRINCIPAL_RETURN_GROUP_TRANSACTION": async (input: EditPrincipalReturnGroupTransactionInput, portfolio: RWAPortfolio, prisma: Prisma.TransactionClient) => {
        logger.debug({ msg: "Editing principal return transaction", input });
        await prisma.rWAGroupTransaction.update({
            where: {
                id_portfolioId: {
                    id: input.id,
                    portfolioId: portfolio.id
                }
            },
            data: {
                type: "PrincipalReturn",
            }
        });

        for (const feeTx of input.feeTransactions ?? []) {
            await prisma.rWABaseTransaction.update({
                where: {
                    id_portfolioId: {
                        id: input.id,
                        portfolioId: portfolio.id
                    }
                },
                data: {
                    ...feeTx,
                    portfolioId: portfolio.id,
                }
            });
        }

        if (input.cashTransaction) {
            await prisma.rWABaseTransaction.update({
                where: {
                    id_portfolioId: {
                        id: input.cashTransaction.id,
                        portfolioId: portfolio.id
                    }
                },
                data: {
                    ...input.cashTransaction,
                    portfolioId: portfolio.id,
                }
            });

        }
    },
    "EDIT_ASSET_PURCHASE_GROUP_TRANSACTION": async (input: EditAssetPurchaseGroupTransactionInput, portfolio: RWAPortfolio, prisma: Prisma.TransactionClient) => {
        logger.debug({ msg: "Editing asset purchase transaction", input });
        await prisma.rWAGroupTransaction.update({
            where: {
                id_portfolioId: {
                    id: input.id,
                    portfolioId: portfolio.id
                }
            },
            data: {
                type: "AssetPurchase",
            }
        });

        for (const feeTx of input.feeTransactions ?? []) {
            await prisma.rWABaseTransaction.update({
                where: {
                    id_portfolioId: {
                        id: input.id,
                        portfolioId: portfolio.id
                    }
                },
                data: {
                    ...feeTx,
                    portfolioId: portfolio.id,
                }
            });
        }

        if (input.cashTransaction) {
            await prisma.rWABaseTransaction.update({
                where: {
                    id_portfolioId: {
                        id: input.cashTransaction.id,
                        portfolioId: portfolio.id
                    }
                },
                data: {
                    ...input.cashTransaction,
                    portfolioId: portfolio.id,
                }
            });

        }
    },
    "EDIT_ASSET_SALE_GROUP_TRANSACTION": async (input: EditAssetSaleGroupTransactionInput, portfolio: RWAPortfolio, prisma: Prisma.TransactionClient) => {
        logger.debug({ msg: "Editing asset sale transaction", input });
        await prisma.rWAGroupTransaction.update({
            where: {
                id_portfolioId: {
                    id: input.id,
                    portfolioId: portfolio.id
                }
            },
            data: {
                type: "AssetSale",
            }
        });

        for (const feeTx of input.feeTransactions ?? []) {
            await prisma.rWABaseTransaction.update({
                where: {
                    id_portfolioId: {
                        id: input.id,
                        portfolioId: portfolio.id
                    }
                },
                data: {
                    ...feeTx,
                    portfolioId: portfolio.id,
                }
            });
        }

        if (input.cashTransaction) {
            await prisma.rWABaseTransaction.update({
                where: {
                    id_portfolioId: {
                        id: input.cashTransaction.id,
                        portfolioId: portfolio.id
                    }
                },
                data: {
                    ...input.cashTransaction,
                    portfolioId: portfolio.id,
                }
            });

        }
    },
    "EDIT_INTEREST_DRAW_GROUP_TRANSACTION": async (input: EditInterestDrawGroupTransactionInput, portfolio: RWAPortfolio, prisma: Prisma.TransactionClient) => {
        logger.debug({ msg: "Editing interest draw transaction", input });
        await prisma.rWAGroupTransaction.update({
            where: {
                id_portfolioId: {
                    id: input.id,
                    portfolioId: portfolio.id
                }
            },
            data: {
                type: "InterestDraw",
            }
        });

        if (input.interestTransaction) {
            await prisma.rWABaseTransaction.update({
                where: {
                    id_portfolioId: {
                        id: input.interestTransaction.id,
                        portfolioId: portfolio.id
                    }
                },
                data: {
                    ...input.interestTransaction,
                    portfolioId: portfolio.id,
                }
            });

        }
    },
    "EDIT_INTEREST_RETURN_GROUP_TRANSACTION": async (input: EditInterestReturnGroupTransactionInput, portfolio: RWAPortfolio, prisma: Prisma.TransactionClient) => {
        logger.debug({ msg: "Editing interest return transaction", input });
        await prisma.rWAGroupTransaction.update({
            where: {
                id_portfolioId: {
                    id: input.id,
                    portfolioId: portfolio.id
                }
            },
            data: {
                type: "InterestReturn",
            }
        });

        if (input.interestTransaction) {
            await prisma.rWABaseTransaction.update({
                where: {
                    id_portfolioId: {
                        id: input.interestTransaction.id,
                        portfolioId: portfolio.id
                    }
                },
                data: {
                    ...input.interestTransaction,
                    portfolioId: portfolio.id,
                }
            });

        }
    },
    "ADD_FEE_TRANSACTIONS_TO_GROUP_TRANSACTION": async (input: AddFeeTransactionsToGroupTransactionInput, portfolio: RWAPortfolio, prisma: Prisma.TransactionClient) => {
        logger.debug({ msg: "Adding fee transactions to group transaction", input });
        for (const feeTx of input.feeTransactions ?? []) {
            const feeTxEntity = await prisma.rWABaseTransaction.create({
                data: {
                    ...feeTx,
                    portfolioId: portfolio.id,
                }
            });

            await prisma.rWABaseTransactionOnGroupTransaction.create({
                data: {
                    portfolioId: portfolio.id,
                    baseTransactionId: feeTxEntity.id,
                    groupTransactionId: input.id,
                }
            });
        }
    },
    "EDIT_FEE_TRANSACTION": async (input: EditFeeTransactionInput, portfolio: RWAPortfolio, prisma: Prisma.TransactionClient) => {
        logger.debug({ msg: "Editing fee transaction", input });
        await prisma.rWABaseTransaction.update({
            where: {
                id_portfolioId: {
                    id: input.id,
                    portfolioId: portfolio.id
                }
            },
            data: {
                ...input,
                portfolioId: portfolio.id,
            }
        });
    },
    "REMOVE_FEE_TRANSACTION_FROM_GROUP_TRANSACTION": async (input: RemoveFeeTransactionFromGroupTransactionInput, portfolio: RWAPortfolio, prisma: Prisma.TransactionClient) => {
        logger.debug({ msg: "Removing fee transaction from group transaction", input });
        await prisma.rWABaseTransaction.delete({
            where: {
                id_portfolioId: {
                    id: input.feeTransactionId,
                    portfolioId: portfolio.id
                }
            }
        });
    },
    "DELETE_GROUP_TRANSACTION": async (input: DeleteGroupTransactionInput, portfolio: RWAPortfolio, prisma: Prisma.TransactionClient) => {
        logger.debug({ msg: "Deleting group transaction", input });
        const { cashTransactionId, fixedTransactionId } = await prisma.rWAGroupTransaction.delete({
            where: {
                id_portfolioId: {
                    id: input.id,
                    portfolioId: portfolio.id
                }
            },
        });

        if (cashTransactionId) {
            await prisma.rWABaseTransaction.delete({
                where: {
                    id_portfolioId: {
                        id: cashTransactionId,
                        portfolioId: portfolio.id
                    }
                }
            });
        }

        if (fixedTransactionId) {
            await prisma.rWABaseTransaction.delete({
                where: {
                    id_portfolioId: {
                        id: fixedTransactionId,
                        portfolioId: portfolio.id
                    }
                }
            });
        }
    }
}

async function handleRwaDocumentStrand(strand: InternalTransmitterUpdate<RealWorldAssetsDocument, "global">, prisma: Prisma.TransactionClient) {
    logger.debug(`Received strand for document ${strand.documentId} with operations: ${strand.operations.map(op => op.type).join(", ")}`);
    const portfolio = await prisma.rWAPortfolio.findFirst({
        where: {
            driveId: strand.driveId,
            documentId: strand.documentId
        }
    })

    if (portfolio === null) {
        logger.debug(`Skipping strand for document ${strand.documentId} as it doesn't exist in the read model`);
        return;
    }


    if (strandStartsFromOpZero(strand) || !allOperationsAreSurgical(strand, surgicalOperations)) {
        await rebuildRwaPortfolio(strand.driveId, strand.documentId, strand.state, prisma);
        return;
    }

    for (const operation of strand.operations) {
        await doSurgicalRwaPortfolioUpdate(operation, portfolio, prisma);
    }
}

async function doSurgicalRwaPortfolioUpdate(operation: OperationUpdate, portfolio: RWAPortfolio, prisma: Prisma.TransactionClient) {
    logger.debug({ msg: "Doing surgical rwa portfolio update", name: operation.type });
    await surgicalOperations[operation.type](operation.input, portfolio, prisma);
}

function allOperationsAreSurgical(strand: InternalTransmitterUpdate<RealWorldAssetsDocument, "global">, surgicalOperations: Record<string, (input: any, portfolio: RWAPortfolio, prisma: Prisma.TransactionClient) => void>) {
    const allOperationsAreSurgical = strand.operations.filter(op => surgicalOperations[op.type] === undefined).length === 0;
    logger.debug(`All operations are surgical: ${allOperationsAreSurgical}`);
    return allOperationsAreSurgical
}

