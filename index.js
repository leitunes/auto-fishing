const path = require('path');
const fs = require('fs');
const moment = require('moment');

module.exports = function autoFishing(mod) {
	const ITEMS_FISHES = [
		[206400, 206401], //tier 0
		[206402, 206403], //tier 1
		[206404, 206405], //tier 2
		[206406, 206407], //tier 3
		[206408, 206409, 206410], //tier 4
		[206411, 206412, 206413], //tier 5
		[206414, 206415, 206416, 206417], //tier 6
		[206418, 206419, 206420, 206421], //tier 7
		[206422, 206423, 206424, 206425], //tier 8
		[206426, 206427, 206428, 206429, 206430], //tier 9
		[206431, 206432, 206433, 206434, 206435], //tier 10
		[206500, 206501, 206502, 206503, 206504, 206505], //baf
	];
	const ITEMS_RODS = [
		[...range(206721, 206728)], //Fairywing Rods
		[...range(206701, 206708)], //Xermetal Rods
		[...range(206711, 206718)], //Ash Sapling Rods
		[206700], //Old Rod
	];
	const PRICES = [2, 4, 6, 8, 10, 12, 14, 16, 19, 22, 25, 50];
	const FILET_ID = 204052;
	const BAITS = {
		70271: 206000, //0%
		70272: 206001, //20%
		70273: 206002, //40%
		70274: 206003, //60%
		70275: 206004, //80%
		70360: 206900, //80%+30%
		70365: 206905, //80%+5%
		70364: 206904, //80%+10%
		70361: 206901, //80%+25%
		70281: 206005, //worm
		70282: 206006, //worm
		70283: 206007, //worm
		70284: 206008, //worm
		70285: 206009, //worm
		70362: 206902, //worm 80%+20%
		70363: 206903, //worm 80%+15%
		70286: 206828, //Celisium Fragment Bait,
		70379: 143188, //event
		5000012 : 143188 //event
	};
	const ITEMS_BANKER = [60264, 160326, 170003, 210111, 216754];
	const ITEMS_SELLER = [160324, 170004, 210109, 60262, 60263, 160325, 170006, 210110];
	const TEMPLATE_SELLER = [9903, 9906, 1960, 1961];
	const TEMPLATE_BANKER = 1962;
	const ITEMS_SALAD = [206020, 206040];
	const flatSingle = arr => [].concat(...arr);
	let enabled = false,
		playerLocation = {},
		request = {},
		npcList = {},
		pcbangBanker = null,
		scrollsInCooldown = false,
		endSellingTimer = null,
		lastRecipe = null,
		sellItemsCount = 0,
		idleCheckTimer = null;
	let DEBUG = false;
	let hooks = [];

	let extendedFunctions = {
		'banker': {
			'C_PUT_WARE_ITEM': false,
		},
		'seller': {
			'C_STORE_SELL_ADD_BASKET': false,
			'S_STORE_BASKET': false,
			'C_STORE_COMMIT': false,
		}
	};

	let statistic = [],
		startTime = null,
		endTime = null,
		lastLevel = null;

	let config, settingsPath;
	if (mod.proxyAuthor !== 'caali' || !global.TeraProxy)
		mod.warn('You are trying to use auto-fishing on an unsupported version of tera-proxy.');
	try {
		let commit = mod.dispatch.protocol.messages.get('C_STORE_COMMIT');
		if (commit.get(1)[1][0] == 'npc') {
			mod.dispatch.protocol.messages.set('C_STORE_COMMIT', new Map().set(1, [
				['gameId', 'uint64'],
				['contract', 'int32']
			]));
		}
	} catch (e) {}
	mod.game.initialize(['inventory']);
	mod.game.on('enter_game', () => {
		try {
			settingsPath = `./${mod.game.me.name}-${mod.game.serverId}.json`;
			getConfigData(settingsPath);
			for (var type in extendedFunctions) {
				for (var opcode in extendedFunctions[type]) {
					var test = mod.dispatch.protocolMap.name.get(opcode);
					if (test !== undefined && test != null) extendedFunctions[type][opcode] = true;
				}
			}
			if (config.filetmode == 'bank' && Object.values(extendedFunctions.banker).some(x => !x)) {
				config.filetmode = false;
				mod.command.message('C_PUT_WARE_ITEM not mapped, banker functions will be disabled!');
			}
			if (config.filetmode == 'sellscroll' && Object.values(extendedFunctions.seller).some(x => !x)) {
				config.filetmode = false;
				mod.command.message('C_STORE_SELL_ADD_BASKET|S_STORE_BASKET|C_STORE_COMMIT not mapped, seller functions will be disabled!');
			}
		} catch (e) {
			console.log(e);
		}
	});

	function hook(...args) {
		hooks.push(mod.hook(...args));
	}

	function toggleHooks() {
		enabled = !enabled;
		mod.clearAllTimeouts();
		if (enabled) {
			mod.command.message('Auto fishing activated. Manually start fishing now.');
		} else {
			mod.command.message('Auto fishing deactivated.');
		}
		if (enabled) {
			hook('S_FISHING_BITE', 1, sFishingBite);
			hook('S_START_FISHING_MINIGAME', 1, sStartFishingMinigame);
			hook('S_FISHING_CATCH', 1, sFishingCatch);
			hook('S_SYSTEM_MESSAGE', 1, sSystemMessage);
			hook('S_REQUEST_CONTRACT', 1, sRequestContract);
			hook('S_CANCEL_CONTRACT', 1, sCancelContract);
			hook('S_END_PRODUCE', 1, sEndProduce);
			hook('S_DIALOG', 2, sDialog);
			if (!Object.values(extendedFunctions.seller).some(x => !x)) {
				hook('S_STORE_BASKET', 'raw', sStoreBasket);
			}
			hook('S_RP_ADD_ITEM_TO_DECOMPOSITION_CONTRACT', 1, sRpAddItem);
			hook('S_SPAWN_NPC', 11, sSpawnNpc);
			hook('S_ABNORMALITY_BEGIN', 3, sAbnBegin);
		} else {
			for (var i = 0; i < hooks.length; i++) {
				mod.unhook(hooks[i]);
				delete hooks[i];
			}
		}
	}

	this.destructor = () => {
		mod.clearAllTimeouts();
	};

	//region Hooks
	function sAbnBegin(event) {
		if (mod.game.me.is(event.target)) {
			switch (request.action) {
				case 'usesalad':
					{
						if (event.id == 70261)
							mod.setTimeout(() => {
								makeDecision();
							}, config.time.bait);
						break;
					}
				case 'usebait':
					{
						if (Object.keys(BAITS).includes(event.id.toString()))
							mod.setTimeout(() => {
								makeDecision();
							}, config.time.bait);
						break;
					}
			}
		}
	}

	function sSpawnNpc(event) {
		switch (request.action) {
			case "bank":
				{
					if (event.relation == 12 && event.templateId == TEMPLATE_BANKER && mod.game.me.is(event.owner)) {
						request.banker = event;
						mod.setTimeout(() => {
							contactToNpc(request.banker.gameId);
						}, rng(3000, 5000));
					}
					break;
				}
			case "sellscroll":
				{
					if (event.relation == 12 && TEMPLATE_SELLER.includes(event.templateId) && mod.game.me.is(event.owner)) {
						request.seller = event;
						mod.setTimeout(() => {
							contactToNpc(request.seller.gameId);
						}, rng(3000, 5000));
					}
					break;
				}
		}
	}

	function sRpAddItem() {
		if (request.action == 'dismantle') {
			if (request.fishes.length > 0) {
				mod.setTimeout(() => {
					dismantleFish();
				}, rng(config.time.dismantle));
			} else {
				mod.setTimeout(() => {
					commitDecomposition();
				}, 300);
			}
		}
	}

	function sFishingBite(event) {
		if (mod.game.me.is(event.gameId)) {
			mod.setTimeout(() => {
				mod.send('C_START_FISHING_MINIGAME', 1, {});
			}, rng(config.time.stMinigame));
		}
	}

	function sStartFishingMinigame(event) {
		if (mod.game.me.is(event.gameId)) {
			lastLevel = event.level;
			if (config.skipbaf && (event.level == 11 || (abnormalityDuration(70261) > 0 && event.level == 7))) {
				mod.setTimeout(() => {
					mod.send('C_END_FISHING_MINIGAME', 1, {
						success: false
					});
					mod.setTimeout(() => {
						makeDecision();
					}, rng(config.time.rod));
				}, rng(8000,10000));

			} else {
				mod.setTimeout(() => {
					mod.send('C_END_FISHING_MINIGAME', 1, {
						success: true
					});
				}, rng(config.time.minigame));
			}
		}
	}

	function sFishingCatch(event) {
		if (mod.game.me.is(event.gameId)) {
			endTime = moment();
			if (startTime != null && lastLevel != null)
				statistic.push({
					level: lastLevel,
					time: endTime.diff(startTime)
				});
			startTime = moment();
			mod.setTimeout(() => {
				makeDecision();
			}, rng(config.time.decision));
		}
	}

	function sSystemMessage(event) {
		let message = mod.parseSystemMessage(event.message);
		if (message.id == 'SMT_CANNOT_FISHING_NON_AREA') {
			mod.setTimeout(() => {
				makeDecision();
			}, rng(config.time.rod));
		}
	}

	function sRequestContract(event) {
		switch (request.action) {
			case "sellscroll":
			case "selltonpc":
				{
					if (event.type == 9) {
						request.seller.contractId = event.id;
						if (request.fishes.length === 0) {
							mod.clearTimeout(endSellingTimer);
							endSellingTimer = mod.setTimeout(() => {
								cancelContract(9, request.seller.contractId);
							}, 5000);
						} else {
							mod.setTimeout(() => {
								sellFish();
							}, rng(config.time.sell));
						}
					}
					break;
				}
			case "bank":
				{
					if (event.type == 26) {
						request.banker.contractId = event.id;
						bankFillets();
					}
				}
			case "dismantle":
				{
					if (event.type == 89) {
						request.contractId = event.id;
						dismantleFish();
					}
					break;
				}
		}

	}

	function sCancelContract(event) {
		switch (request.action) {
			case "sellscroll":
			case "selltonpc":
				{
					if (event.type == 9 && request.seller.contractId == event.id)
						mod.setTimeout(() => {
							makeDecision();
						}, rng(config.time.contract));
					break;
				}
			case "bank":
				{
					if (event.type == 26 && request.banker.contractId == event.id) {
						mod.setTimeout(() => {
							makeDecision();
						}, rng(config.time.contract));
					}
				}
			case "dismantle":
				{
					if (event.type == 89 && request.contractId == event.id) {
						mod.setTimeout(() => {
							makeDecision();
						}, rng(config.time.contract));
					}
					break;
				}
		}
	}

	function sEndProduce(event) {
		if (request.action == 'craft') {
			if (event.success) {
				mod.setTimeout(() => {
					makeDecision();
				}, rng(config.time.contract));
			}
		}
	}

	function sDialog(event) {
		switch (request.action) {
			case "bank":
				{
					if (event.gameId == request.banker.gameId) {
						request.banker.dialogId = event.id;
						mod.setTimeout(() => {
							mod.send('C_DIALOG', 1, {
								id: request.banker.dialogId,
								index: 1,
								questReward: -1,
								unk: -1
							})
						}, rng(config.time.dialog));
					}
					break;
				}
			case "sellscroll":
			case "selltonpc":
				{
					if (event.gameId == request.seller.gameId) {
						request.seller.dialogId = event.id;
						mod.setTimeout(() => {
							mod.send('C_DIALOG', 1, {
								id: request.seller.dialogId,
								index: 1,
								questReward: -1,
								unk: -1
							})
						}, rng(config.time.dialog));
					}
					break;
				}
		}
	}

	function sStoreBasket() {
		switch (request.action) {
			case "sellscroll":
			case "selltonpc":
				{
					if (request.fishes.length > 0 && sellItemsCount < 7) {
						sellItemsCount++;
						mod.setTimeout(() => {
							sellFish();
						}, rng(config.time.sell));
						if (request.fishes.length < 8) {
							mod.clearTimeout(endSellingTimer);
							endSellingTimer = mod.setTimeout(() => {
								cancelContract(9, request.seller.contractId);
							}, 10000);
						}
					} else {
						mod.setTimeout(() => {
							if (sellItemsCount > 0)
								sellFishes();
							else {
								mod.clearTimeout(endSellingTimer);
								endSellingTimer = mod.setTimeout(() => {
									cancelContract(9, request.seller.contractId);
								}, 1000);
							}
						}, 300);
					}
					break;
				}
		}
	}
	//endregion

	//region Permanent hooks
	mod.hook('C_START_PRODUCE', 1, event => {
		lastRecipe = event.recipe;
	});
	mod.hook('S_SPAWN_NPC', 11, event => {
		if (TEMPLATE_SELLER.includes(event.templateId) ||
			TEMPLATE_BANKER == event.templateId && event.owner === 0n ||
			mod.game.me.is(event.owner)) {
			npcList[event.gameId] = event;
		}
	})
	mod.hook('S_DESPAWN_NPC', 3, event => {
		delete npcList[event.gameId];
	})
	mod.hook('S_SPAWN_USER', 14, event => {
		if (event.gm && enabled)
			switch (config.gmmode) {
				case 'exit':
					{
						console.log(`auto-fishing(${mod.game.me.name})|ERROR: GM is near you, exit game xD`);
						toggleHooks();
						mod.toClient('S_EXIT', 3, {
							category: 0,
							code: 0
						});
						break;
					}
				case 'lobby':
					{
						console.log(`auto-fishing(${mod.game.me.name})|ERROR: GM is near you, return to lobby`);
						toggleHooks();
						mod.toServer('C_RETURN_TO_LOBBY', 1, {});
						break;
					}
				case 'stop':
					{
						mod.command.message(`ERROR: GM is near you, fishing stoped`);
						console.log(`auto-fishing(${mod.game.me.name})|ERROR: GM is near you, fishing stoped`);
						toggleHooks();
						break
					}
				default:
					{
						mod.command.message(`Warning: GM is near you.`);
						console.log(`auto-fishing(${mod.game.me.name})|Warning: GM is near you.`);
						break
					}
			}
	})
	mod.hook('S_PCBANGINVENTORY_DATALIST', 1, event => {
		for (let item of event.inventory) {
			if (ITEMS_BANKER.includes(item.item)) {
				pcbangBanker = {
					slot: item.slot
				};
			}
		}
	});
	mod.hook('S_START_COOLTIME_ITEM', 1, event => {
		if ((ITEMS_BANKER.includes(event.item) || ITEMS_SELLER.includes(event.item)) && event.cooldown > 0 && !scrollsInCooldown) {
			scrollsInCooldown = true;
			setTimeout(() => {
				scrollsInCooldown = false;
			}, event.cooldown * 1000);
		}
	});
	mod.hook('C_PLAYER_LOCATION', 5, event => {
		playerLocation = event;
	});
	mod.hook('S_LOAD_TOPO', 3, event => {
		playerLocation.loc = event.loc;
		playerLocation.w = 0;
		if (enabled)
			mod.clearAllTimeouts();
	});
	mod.hook('C_RETURN_TO_LOBBY', 1, event => {
		if (enabled)
			mod.clearAllTimeouts();
	});
	mod.hook('S_EXIT', 3, event => {
		if (enabled)
			mod.clearAllTimeouts();
	});
	//endregion
	//region Abnormality tracking
	let abnormalities = {};
	mod.hook('S_ABNORMALITY_BEGIN', 3, event => {
		if (mod.game.me.is(event.target))
			abnormalities[event.id] = Date.now() + event.duration;
	});

	mod.hook('S_ABNORMALITY_REFRESH', 1, event => {
		if (mod.game.me.is(event.target))
			abnormalities[event.id] = Date.now() + event.duration;
	});

	mod.hook('S_ABNORMALITY_END', 1, event => {
		if (mod.game.me.is(event.target))
			delete abnormalities[event.id];
	});

	function abnormalityDuration(id) {
		if (!abnormalities[id])
			return 0;
		return abnormalities[id] - Date.now();
	}
	//endregion
	//region Decision
	function makeDecision() {
		mod.clearTimeout(idleCheckTimer);
		idleCheckTimer = mod.setTimeout(() => {
			makeDecision();
		}, 300 * 1000);
		let action = "userod";
		request = {};
		let filets = mod.game.inventory.findInBag(204052);
		let fishes = mod.game.inventory.findAllInBag(flatSingle(ITEMS_FISHES)).filter(f => !config.blacklist.includes(f.id));
		let bait = mod.game.inventory.findInBag(Object.values(BAITS));
		let salad = mod.game.inventory.findInBag([206020, 206040]);
		if (config.autosalad) {
			if (abnormalityDuration(70261) <= 0 && salad !== undefined)
				action = "usesalad";
		}
		if (bait === undefined) {
			if (filets === undefined || filets.amount < 60) {
				action = "dismantle";
			} else {
				action = "craft";
			}
		} else {
			if (Object.keys(BAITS).every((el) => {
					return abnormalityDuration(Number(el)) <= 0;
				}))
				action = "usebait";
		}
		if (mod.game.inventory.bagSize - mod.game.inventory.bag.length <= 3) {
			if (filets === undefined || filets.amount < 60)
				action = "dismantle";
			else
				action = "fullinven";

		}
		if (filets !== undefined && filets.amount >= 9000 &&
			config.filetmode != 'sellscroll' &&
			config.filetmode != 'selltonpc') {
			action = "toomanyfilets"
		}
		//check

		switch (action) {
			case "fullinven":
				{
					action = config.filetmode;
					switch (config.filetmode) {
						case 'sellscroll':
							{
								if (scrollsInCooldown) {
									console.log("Scroll in cooldown retry in 1 min");
									mod.setTimeout(() => {
										makeDecision();
									}, 60 * 1000);
									action = 'wait';
								} else {
									let scroll = mod.game.inventory.findInBag(ITEMS_SELLER);
									if (scroll === undefined) {
										mod.command.message(`ERROR: Cant find any seller scroll`);
										console.log(`auto-fishing(${mod.game.me.name})|ERROR: Cant find any seller scroll`);
										action = 'aborted';
									} else {
										request = {
											scroll: scroll,
											fishes: fishes
										};
									}
								}
								break;
							}
						case 'selltonpc':
							{
								let npc = findClosestNpc();
								if (npc===undefined||npc.distance===undefined|| npc.distance > config.contdist * 25) {
									mod.command.message('ERROR: No seller npc found at the acceptable range.');
									console.log(`auto-fishing(${mod.game.me.name})|ERROR: No seller npc found at the acceptable range.`);
									action = 'aborted';
								} else {
									request = {
										seller: npc,
										fishes: fishes
									};
								}
								break;
							}
						default:
							{
								if (fishes.length === 0) {
									mod.command.message(`ERROR: Can't find any fishes for dismantle`);
									console.log(`auto-fishing(${mod.game.me.name})|ERROR: Can't find any fishes for dismantle`);
									action = 'aborted';
								} else {
									action = 'dismantle';
									request = {
										fishes: fishes.slice(0, 20)
									}
								}
								break;
							}
					}
					break;
				}
			case "toomanyfilets":
				{
					switch (config.filetmode) {
						case 'bank':
							{
								action = 'bank';
								if (scrollsInCooldown) {
									console.log("Scroll in cooldown retry in 1 min");
									mod.setTimeout(() => {
										makeDecision();
									}, 60 * 1000);
									action = 'wait';
								} else {
									if (pcbangBanker == null) {
										let scroll = mod.game.inventory.findInBag(ITEMS_BANKER);
										if (scroll === undefined) {
											mod.command.message(`ERROR: Cant find any banker scroll`);
											console.log(`auto-fishing(${mod.game.me.name})|ERROR: Cant find any banker scroll`);
											action = 'aborted';
										} else {
											request = {
												scroll: scroll,
												filets: filets
											};
										}
									} else {
										request = {
											slot: pcbangBanker,
											filets: filets
										};
									}
								}
								break;
							}
						default:
							{
								mod.command.message(`ERROR: No action for toomanyfilets`);
								action = 'aborted';
								break;
							}
					}
					break;
				}
			case "userod":
				{
					let rod = mod.game.inventory.findInBag(flatSingle(ITEMS_RODS));
					request = {
						rod: rod
					};
					break;
				}
			case "usesalad":
				{
					request = {
						salad: salad
					}
					break;
				}
			case "usebait":
				{
					request = {
						bait: bait
					}
					break;
				}
			case "dismantle":
				{

					if (fishes.length === 0) {
						mod.command.message(`ERROR: Can't find any fishes for dismantle`);
						console.log(`auto-fishing(${mod.game.me.name})|ERROR: Can't find any fishes for dismantle`);
						action = 'aborted';
					} else {
						request = {
							fishes: fishes.slice(0, 20)
						}
					}
					break;
				}
			case "craft":
				{
					if (config.recipe === undefined) {
						mod.command.message(`ERROR: No crafting recipe found `);
						console.log(`auto-fishing(${mod.game.me.name})|ERROR: No crafting recipe found`);
						action = 'aborted';
					} else {
						request = {
							recipe: config.recipe
						}
					}

				}
		}
		if (DEBUG)
			mod.command.message(`Decision ${action}`);
		request.action = action;
		processDecision();
	}

	function processDecision() {
		switch (request.action) {
			case "dismantle":
				{
					mod.setTimeout(() => {
						requestContract(89);
					}, rng(config.time.contract));
					break;
				}
			case "usebait":
				{
					mod.setTimeout(() => {
						useItem(request.bait);
					}, rng(config.time.bait));
					break;
				}
			case "userod":
				{
					mod.setTimeout(() => {
						useItem(request.rod);
					}, rng(config.time.rod));
					break;
				}
			case "usesalad":
				{
					mod.setTimeout(() => {
						useItem(request.salad);
					}, rng(config.time.bait));
					break;
				}
			case "bank":
				{
					mod.setTimeout(() => {
						if (request.slot !== undefined)
							useSlot(request.slot);
						else
							useItem(request.scroll);
					}, rng(config.time.rod));
					break;
				}
			case "selltonpc":
				{
					mod.setTimeout(() => {
						contactToNpc(request.seller.gameId);
					}, rng(config.time.rod));
					break;
				}
			case "sellscroll":
				{
					mod.setTimeout(() => {
						useItem(request.scroll);
					}, rng(config.time.rod));
					break;
				}
			case "craft":
				{
					mod.setTimeout(() => {
						startCraft();
					}, rng(config.time.contract));
					break;
				}
			case "aborted":
				{
					toggleHooks();
					break;
				}
		}
	}
	//endregion

	//region Send
	function bankFillets() {
		let amount = (config.bankAmount > request.filets.amount ? request.filets.amount : config.bankAmount) - 150;
		mod.send('C_PUT_WARE_ITEM', 2, {
			gameId: mod.game.me.gameId,
			type: 1,
			page: 0,
			money: 0n,
			invenPos: request.filets.slot,
			dbid: request.filets.id,
			uid: request.filets.dbid,
			amont: amount,
			bankPos: 0
		});
		mod.setTimeout(() => {
			cancelContract(26, request.banker.contractId);
		}, 5000);
	}

	function sellFishes() {
		sellItemsCount = 0;
		mod.send('C_STORE_COMMIT', 1, {
			gameId: mod.game.me.gameId,
			contract: request.seller.contractId
		});
	}

	function useItem(item) {
		mod.send('C_USE_ITEM', 3, {
			gameId: mod.game.me.gameId,
			id: item.id,
			dbid: item.dbid,
			target: 0,
			amount: 1,
			dest: 0,
			loc: playerLocation.loc,
			w: playerLocation.w,
			unk1: 0,
			unk2: 0,
			unk3: 0,
			unk4: true
		});
	}

	function useSlot(slot) {
		mod.send('C_PCBANGINVENTORY_USE_SLOT', 1, slot);
	}

	function contactToNpc(gameId) {
		mod.send('C_NPC_CONTACT', 2, {
			gameId: gameId
		});
	}

	function sellFish() {
		let fish = request.fishes.shift();
		if (fish != undefined) {
			mod.send('C_STORE_SELL_ADD_BASKET', 1, {
				cid: mod.game.me.gameId,
				npc: request.seller.contractId,
				item: fish.id,
				quantity: 1,
				slot: fish.slot
			});
		} else {
			mod.clearTimeout(endSellingTimer);
			endSellingTimer = mod.setTimeout(() => {
				cancelContract(9, request.seller.contractId);
			}, 1000);
		}
	}

	function dismantleFish() {
		let fish = request.fishes.shift();
		if (fish != undefined)
			mod.send('C_RQ_ADD_ITEM_TO_DECOMPOSITION_CONTRACT', 1, {
				contract: request.contractId,
				dbid: fish.dbid,
				itemid: fish.id,
				amount: 1
			});
	}

	function commitDecomposition() {
		mod.send('C_RQ_COMMIT_DECOMPOSITION_CONTRACT', 1, {
			contract: request.contractId
		});
		mod.setTimeout(() => { //reduce opcodes
			cancelContract(89, request.contractId);
		}, 10000);
	}

	function requestContract(type, obj) {
		let contract = {
			type: type
		};
		mod.send('C_REQUEST_CONTRACT', 1, contract);
	}

	function cancelContract(type, id) {
		mod.send('C_CANCEL_CONTRACT', 1, {
			type: type,
			id: id
		});
	}

	function startCraft() {
		mod.send('C_START_PRODUCE', 1, {
			recipe: request.recipe,
			unk: 0
		});
	}

	//endregion



	//region Helper

	function getItemIdChatLink(chatLink) {
		let regexId = /#(\d*)@/;
		let id = chatLink.match(regexId);
		if (id) return parseInt(id[1])
		else return null;
	}
	function findClosestNpc() {
		let npc = Object.values(npcList).filter(x => TEMPLATE_SELLER.includes(x.templateId));
		for(let i=npc.length;i-->0;npc[i].distance=npc[i].loc.dist3D(playerLocation.loc));
		npc=npc.reduce((result, obj) => {
			return (!(obj.distance > result.distance)) ? obj : result;
		}, {});
		return npc;
	}
	function getConfigData(pathToFile) {
		try {
			config = JSON.parse(fs.readFileSync(path.join(__dirname, pathToFile)));
		} catch (e) {
			config = {};
		}
		checkConfig();
	}

	function checkConfig() {
		if (config.time === undefined)
			config.time = {};
		if (config.time.minigame === undefined) {
			config.time.minigame = {};
			config.time.minigame.min = 4000;
			config.time.minigame.max = 5000;
		}
		if (config.time.stMinigame === undefined) {
			config.time.stMinigame = {};
			config.time.stMinigame.min = 2000;
			config.time.stMinigame.max = 4000;
		}
		if (config.time.rod === undefined) {
			config.time.rod = {};
			config.time.rod.min = 4500;
			config.time.rod.max = 5500;
		}
		if (config.time.bait === undefined) {
			config.time.bait = {};
			config.time.bait.min = 250;
			config.time.bait.max = 750;
		}
		if (config.time.sell === undefined) {
			config.time.sell = {};
			config.time.sell.min = 150;
			config.time.sell.max = 300;
		}
		if (config.time.contract === undefined) {
			config.time.contract = {};
			config.time.contract.min = 500;
			config.time.contract.max = 1000;
		}
		if (config.time.dialog === undefined) {
			config.time.dialog = {};
			config.time.dialog.min = 1500;
			config.time.dialog.max = 3000;
		}
		if (config.time.dismantle === undefined) {
			config.time.dismantle = {};
			config.time.dismantle.min = 200;
			config.time.dismantle.max = 400;
		}
		if (config.time.decision === undefined) {
			config.time.decision = {};
			config.time.decision.min = 500;
			config.time.decision.max = 700;
		}
		if (config.bankAmount <= 0)
			config.bankAmount = 8000;
		if (config.contdist < 0)
			config.contdist = 6;
		if (config.blacklist === undefined)
			config.blacklist = [];
		if (config.gmmode === undefined)
			config.gmmode = 'stop';
	}

	function rng(f, s) {
		if (s !== undefined)
			return f + Math.floor(Math.random() * (s - f + 1));
		else
			return f.min + Math.floor(Math.random() * (f.max - f.min + 1));
	}

	function saveConfig(pathToFile, data) {
		fs.writeFile(path.join(__dirname, pathToFile), JSON.stringify(data, null, '\t'), err => {});
	}

	function* range(a, b) {
		for (var i = a; i <= b; ++i) yield i;
	}
	//endregion
	//region Command
	mod.command.add('fish', (key, arg, arg2) => {
		switch (key) {
			case 'blacklist':
				switch (arg) {
					case 'add':
						var tmp = getItemIdChatLink(arg2);
						if (tmp != null) {
							if (config.blacklist.indexOf(tmp) == -1) {
								mod.command.message(`Pushed item id to blacklist: ${tmp}`);
								config.blacklist.push(tmp);
							} else {
								mod.command.message(`Already exist`);
							}

						} else {
							mod.command.message(`Incorrect item id`);
						}

						break;
					case 'remove':
						var tmp = getItemIdChatLink(arg2);
						if (tmp != null) {
							var index = config.blacklist.indexOf(tmp);
							if (index == -1) {
								mod.command.message(`not exist`);
							} else {
								mod.command.message(`Remove item id from blacklist: ${tmp}`);
								config.blacklist.splice(index, 1);
							}
						} else {
							mod.command.message(`Incorrect item id`);
						}
						break;
					case 'reset':
						config.blacklist = [];
						mod.command.message(`Blacklist reset`);
						break;
				}
				break;
			case 'filetmode':
				switch (arg) {
					case 'bank':
						var amount = parseInt(arg2);
						if (amount > 500 && amount < 10000) {
							config.bankAmount = amount;
							mod.command.message(`Set to bank ${config.bankAmount} files after filling inventory`);
						} else {
							config.bankAmount = 8000;
							mod.command.message(`Set to bank ${config.bankAmount} files after filling inventory`);
						}
						config.filetmode = 'bank';
						if (config.filetmode == 'bank' && Object.values(extendedFunctions.banker).some(x => !x)) {
							config.filetmode = false;
							mod.command.message('C_PUT_WARE_ITEM is not mapped, banker functions for auto-fishing will be disabled now.');
						}
						break;
					default:
						mod.command.message(`filetmode disabled`);
						config.filetmode = false;
						break;
				}
				break;

			case 'setrecipe':
				if (lastRecipe != null) {
					mod.command.message(`Recipe id set to: ${lastRecipe}`);
					config.recipe = lastRecipe;
				} else {
					mod.command.message(`Incorrect item id. Manually craft bait when mod enabled`);
				}
				break;
			case 'sellscroll':
				mod.command.message(`Set to sell fishes after filling inventory`);
				config.filetmode = 'sellscroll';
				if (config.filetmode == 'sellscroll' && Object.values(extendedFunctions.seller).some(x => !x)) {
					config.filetmode = false;
					mod.command.message('C_STORE_SELL_ADD_BASKET|S_STORE_BASKET|C_STORE_COMMIT not mapped, seller functions will be disabled!');
				}
				break;
			case 'selltonpc':
				config.filetmode = 'selltonpc';
				mod.command.message(`Sell to npc instead using scrolls enabled.`);
				var dist = parseInt(arg);
				if (dist > 0) {
					if (dist > 8)
						dist = 6;
					config.contdist = dist;
					mod.command.message(`Distance for NPC contact set to: ${dist}m`);
				}
				let npc = findClosestNpc();
				if (npc===undefined||npc.distance===undefined|| npc.distance > config.contdist * 25) {
					mod.command.message('Warning: no seller npc at acceptable range');
				}
				break;
			case 'autosalad':
				config.autosalad = !config.autosalad;
				mod.command.message('Auto use of fish salad is now ' + (config.autosalad ? 'en' : 'dis') + 'abled.');
				break;
			case 'gmmode':
				config.gmmode = arg;
				mod.command.message(`Gm detected mode has been set to ${config.gmmode}`);
				break;
			case 'skipbaf':
				config.skipbaf = !config.skipbaf;
				mod.command.message('Skip BAF mode has been ' + (config.skipbaf ? 'en' : 'dis') + 'abled.');
				break;
			case 'save':
				mod.command.message('Configuration has been saved.');
				saveConfig(settingsPath, config);
				break;
			case 'reloadconf':
				getConfigData(settingsPath);
				mod.command.message('Configuration has been reloaded.');
				break;
			case 'debug':
				DEBUG = !DEBUG;
				mod.command.message('Debug mode has been ' + (DEBUG ? 'en' : 'dis') + 'abled.');
				break;
			case 'stats':
				var gr = statistic.reduce((acc, val) => {
					(acc[val['level']] = acc[val['level']] || []).push(val);
					return acc;
				}, {});
				mod.command.message(`Printing stats.`);
				for (var lv in gr) {
					mod.command.message(`${lv} level:${gr[lv].length}`);
				}
				var timePerFish = statistic.reduce((prev, next) => prev + next.time, 0) / statistic.length;
				mod.command.message(`Total fishes: ${statistic.length}`);
				mod.command.message(`Time per fish: ${(timePerFish/1000).toFixed(2)}s`);
				break;
			default:
				if (key !== undefined) {
					mod.command.message('Incorrect command');
				} else {
					if (config.filetmode == 'selltonpc') {
						let npc =findClosestNpc();
						if (npc===undefined||npc.distance===undefined|| npc.distance > config.contdist * 25) {
							mod.command.message('Warning: no seller npc at acceptable range');
						}
					}
					toggleHooks();
					if (enabled) {
						statistic = [], startTime = null, endTime = null, lastLevel = null;
					}
				}
				break;
		}
	});
	//endregion
}