const MODULE_ID = "movement-approval";
const LANGUAGE_PREFIX = "movementApproval";

const ICON_STATES = {
	ENABLED: "fa-person-walking-dashed-line-arrow-right",
	DISABLED: "fa-person-walking",
};

const MovementApproval = {
	ID: MODULE_ID,
	lastWarningTime: 0,

	initialize() {
		this.registerSettings();
		this.patchRulerMovement();
		this.patchTokenDragging();
		this.registerSocketListeners();
	},

	registerSettings() {
		game.settings.register(this.ID, "enabled", {
			name: "Enable Movement Approval",
			hint: "Requires GM approval for token movement beyond allowed distance.",
			scope: "world",
			config: false,
			type: Boolean,
			default: false,
			onChange: (value) => {
				this.updateControlsIcon(value);
			},
		});

		game.settings.register(this.ID, "pendingRequests", {
			name: "Pending Movement Requests",
			scope: "world",
			config: false,
			type: Object,
			default: {},
		});
	},

	get enabled() {
		return game.settings.get(this.ID, "enabled");
	},

	set enabled(value) {
		void game.settings.set(this.ID, "enabled", value);
	},

	getPendingRequests() {
		return game.settings.get(this.ID, "pendingRequests");
	},

	setPendingRequests(requests) {
		return game.settings.set(this.ID, "pendingRequests", requests);
	},

	patchRulerMovement() {
		const originalMoveToken = Ruler.prototype.moveToken;
		Ruler.prototype.moveToken = async function () {
			if (game.user.isGM || !MovementApproval.enabled) {
				return originalMoveToken.call(this);
			}

			const token = this.token;
			if (!token) return false;

			const pendingRequests = MovementApproval.getPendingRequests();
			if (pendingRequests[token.id]) {
				ui.notifications.warn(
					game.i18n.localize(`${LANGUAGE_PREFIX}.notifications.pendingRequest`),
				);
				this.clear();
				return false;
			}

			game.socket.emit(`module.${MovementApproval.ID}`, {
				type: "requestMovement",
				payload: {
					tokenId: token.id,
					sceneId: token.scene.id,
					rulerName: this.name,
					waypoints: this.waypoints,
					destination: this.destination,
				},
			});

			ui.notifications.info(
				game.i18n.localize(`${LANGUAGE_PREFIX}.notifications.requestSent`),
			);
			this.clear();
		};
	},

	patchTokenDragging() {
		const originalOnDragLeftStart = Token.prototype._onDragLeftStart;
		const originalOnDragLeftMove = Token.prototype._onDragLeftMove;

		Token.prototype._onDragLeftStart = function (event) {
			if (!game.user.isGM && MovementApproval.enabled) {
				MovementApproval.showMovementLockedWarning();
				return false;
			}
			return originalOnDragLeftStart.call(this, event);
		};

		Token.prototype._onDragLeftMove = function (event) {
			if (!game.user.isGM && MovementApproval.enabled) {
				MovementApproval.showMovementLockedWarning();
				return false;
			}
			return originalOnDragLeftMove.call(this, event);
		};
	},

	showMovementLockedWarning() {
		const now = Date.now();
		if (now - this.lastWarningTime > 5000) {
			// prevent spamming, only show every 5 seconds
			ui.notifications.warn(
				game.i18n.localize(`${LANGUAGE_PREFIX}.notifications.movementLocked`),
			);
			this.lastWarningTime = now;
		}
	},

	registerSocketListeners() {
		game.socket.on(`module.${MovementApproval.ID}`, (data) => {
			if (data.type === "requestMovement" && game.user.isGM) {
				this.handleMovementRequest(data.payload);
			} else if (data.type === "movementApproved" && !game.user.isGM) {
				void this.handleMovementApproved(data.payload);
			} else if (data.type === "movementDenied" && !game.user.isGM) {
				void this.handleMovementDenied(data.payload);
			}
		});
	},

	handleMovementRequest(data) {
		const pendingRequests = this.getPendingRequests();
		pendingRequests[data.tokenId] = data;
		void this.setPendingRequests(pendingRequests);

		const scene = game.scenes.get(data.sceneId);
		const token = scene.tokens.get(data.tokenId);

		new Dialog({
			title: game.i18n.localize(`${LANGUAGE_PREFIX}.dialog.title`),
			content: game.i18n.format(`${LANGUAGE_PREFIX}.dialog.content`, {
				tokenName: token.name,
			}),
			buttons: {
				approve: {
					icon: '<i class="fas fa-check"></i>',
					label: game.i18n.localize(`${LANGUAGE_PREFIX}.dialog.approve`),
					callback: () => this.approveMovement(data),
				},
				deny: {
					icon: '<i class="fas fa-times"></i>',
					label: game.i18n.localize(`${LANGUAGE_PREFIX}.dialog.deny`),
					callback: () => this.denyMovement(data),
				},
			},
		}).render(true);
	},

	approveMovement(data) {
		this.clearRuler(data);
		this.removePendingRequest(data.tokenId);
		game.socket.emit(`module.${MovementApproval.ID}`, {
			type: "movementApproved",
			payload: data,
		});
	},

	denyMovement(data) {
		this.clearRuler(data);
		this.removePendingRequest(data.tokenId);
		game.socket.emit(`module.${MovementApproval.ID}`, {
			type: "movementDenied",
			payload: data,
		});
	},

	removePendingRequest(tokenId) {
		const pendingRequests = this.getPendingRequests();
		delete pendingRequests[tokenId];
		void this.setPendingRequests(pendingRequests);
	},

	async handleMovementDenied(_data) {
		ui.notifications.warn(
			game.i18n.localize(`${LANGUAGE_PREFIX}.notifications.movementDenied`),
		);
	},

	async handleMovementApproved(data) {
		const scene = game.scenes.get(data.sceneId);
		const token = scene.tokens.get(data.tokenId);

		if (token.actor.isOwner) {
			ui.notifications.info(
				game.i18n.localize(`${LANGUAGE_PREFIX}.notifications.movementApproved`),
			);
			await this.moveTokenAlongPath(token, data.waypoints, data.destination);
		}
		this.removePendingRequest(data.tokenId);
	},

	async moveTokenAlongPath(token, waypoints, destination) {
		if (waypoints.length > 0) {
			for (const waypoint of waypoints) {
				await token.update({ x: waypoint.x - 50, y: waypoint.y - 50 });
				await CanvasAnimation.getAnimation(token.object.animationName)?.promise;
			}
		}
		await token.update({ x: destination.x - 50, y: destination.y - 50 });
		await CanvasAnimation.getAnimation(token.object.animationName)?.promise;
	},

	clearRuler(data) {
		const ruler = canvas.controls.rulers.children.find(
			(ruler) => ruler.name === data.rulerName,
		);

		if (ruler) ruler.clear();
	},

	handleLockMovementToggle() {
		this.enabled = !this.enabled;
		if (!this.enabled) {
			// Clear all pending requests when disabling
			void this.setPendingRequests({});
		}
	},

	updateControlsIcon(enabled) {
		const icon = enabled ? ICON_STATES.ENABLED : ICON_STATES.DISABLED;
		const controls = ui.controls.controls.find((c) => c.name === "token");
		if (controls) {
			const tool = controls.tools.find((t) => t.name === "lockMovement");
			if (tool) {
				tool.icon = `fas ${icon}`;
				ui.controls.render();
			}
		}
	},
};

Hooks.once("init", () => {
	MovementApproval.initialize();
});

Hooks.on("getSceneControlButtons", (controls) => {
	controls
		.find((c) => c.name === "token")
		.tools.push({
			name: "lockMovement",
			title: game.i18n.localize(
				`${LANGUAGE_PREFIX}.controls.lockMovement.name`,
			),
			icon: `fas ${MovementApproval.enabled ? ICON_STATES.ENABLED : ICON_STATES.DISABLED}`,
			button: true,
			visible: game.user.isGM,
			onClick: () => MovementApproval.handleLockMovementToggle(),
		});
});
