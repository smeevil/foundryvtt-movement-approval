const MODULE_ID = "movement-approval";
const LANGUAGE_PREFIX = "movementApproval";

const ICON_STATES = {
	ENABLED: "fa-person-walking-dashed-line-arrow-right",
	DISABLED: "fa-person-walking",
};

// Add these constants at the top of the file
const PENDING_REQUEST_ICON = "fa-hourglass-half";
const PENDING_REQUEST_TOOL_NAME = "pendingMovementRequest";

const MovementApproval = {
	ID: MODULE_ID,
	lastWarningTime: 0,
	_pendingRequests: {}, // New local variable to store pending requests

	initialize() {
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
	},

	getEnabled() {
		try {
			return game.settings.get(this.ID, "enabled");
		} catch (error) {
			console.warn(
				"Movement Approval: Settings not yet registered, falling back to default.",
			);
			return false;
		}
	},

	setEnabled(value) {
		if (game.user.isGM) {
			game.settings.set(this.ID, "enabled", value);
		}
	},

	getPendingRequests() {
		return this._pendingRequests;
	},

	setPendingRequest(tokenId, request) {
		this._pendingRequests[tokenId] = request;
		if (game.user.isGM) {
			game.socket.emit(`module.${this.ID}`, {
				type: "updatePendingRequests",
				payload: { [tokenId]: request },
			});
		}
	},

	removePendingRequest(tokenId) {
		if (this._pendingRequests[tokenId]?.dialog) {
			this._pendingRequests[tokenId].dialog.close();
		}
		delete this._pendingRequests[tokenId];
		if (game.user.isGM) {
			game.socket.emit(`module.${this.ID}`, {
				type: "updatePendingRequests",
				payload: { [tokenId]: null },
			});
		}
	},

	patchRulerMovement() {
		const originalMoveToken = Ruler.prototype.moveToken;
		Ruler.prototype.moveToken = async function () {
			if (game.user.isGM || !MovementApproval.getEnabled()) {
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

			const pathData = {
				tokenId: token.id,
				sceneId: token.scene.id,
				waypoints: this.waypoints,
				destination: this.destination,
				color: this.color, // Add the ruler's color to the pathData
				userId: game.user.id,
			};

			game.socket.emit(`module.${MovementApproval.ID}`, {
				type: "requestMovement",
				payload: pathData,
			});

			ui.notifications.info(
				game.i18n.localize(`${LANGUAGE_PREFIX}.notifications.requestSent`),
			);

			this.clear();
			MovementApproval.drawStaticPath(pathData);

			MovementApproval.showPendingRequestIcon();

			return false;
		};
	},

	patchTokenDragging() {
		const originalOnDragLeftStart = Token.prototype._onDragLeftStart;
		const originalOnDragLeftMove = Token.prototype._onDragLeftMove;

		Token.prototype._onDragLeftStart = function (event) {
			if (!game.user.isGM && MovementApproval.getEnabled()) {
				MovementApproval.showMovementLockedWarning();
				return false;
			}
			return originalOnDragLeftStart.call(this, event);
		};

		Token.prototype._onDragLeftMove = function (event) {
			if (!game.user.isGM && MovementApproval.getEnabled()) {
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
			} else if (data.type === "cancelMovementRequest" && game.user.isGM) {
				this.handleCancelMovementRequest(data.payload);
			} else if (data.type === "updatePendingRequests" && !game.user.isGM) {
				this.handleUpdatePendingRequests(data.payload);
			}
		});
	},

	handleMovementRequest(data) {
		this.setPendingRequest(data.tokenId, data);
		const scene = game.scenes.get(data.sceneId);
		const token = scene.tokens.get(data.tokenId);

		new Dialog({
			title: game.i18n.localize(`${LANGUAGE_PREFIX}.dialog.title`),
			content: game.i18n.format(`${LANGUAGE_PREFIX}.dialog.content`, {
				tokenName: token.name,
				tokenId: data.tokenId,
			}),
			type: `${MODULE_ID}-dialog`,
			tokenId: data.tokenId,
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
		this.clearStaticPath(data.tokenId);
		this.removePendingRequest(data.tokenId);
		game.socket.emit(`module.${MovementApproval.ID}`, {
			type: "movementApproved",
			payload: data,
		});
		// Clear the ruler for all users
		for (const ruler of canvas.controls.rulers.children) {
			ruler.clear();
		}
	},

	denyMovement(data) {
		this.clearStaticPath(data.tokenId);
		this.removePendingRequest(data.tokenId);
		game.socket.emit(`module.${MovementApproval.ID}`, {
			type: "movementDenied",
			payload: data,
		});
		// Clear the ruler for all users
		for (const ruler of canvas.controls.rulers.children) {
			ruler.clear();
		}
	},

	async handleMovementDenied(data) {
		ui.notifications.warn(
			game.i18n.localize(`${LANGUAGE_PREFIX}.notifications.movementDenied`),
		);
		this.clearStaticPath(data.tokenId);
		// Clear the ruler for all users
		for (const ruler of canvas.controls.rulers.children) {
			ruler.clear();
		}
		this.hidePendingRequestIcon();
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
		this.clearStaticPath(data.tokenId);
		// Clear the ruler for all users
		for (const ruler of canvas.controls.rulers.children) {
			ruler.clear();
		}
		this.hidePendingRequestIcon();
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

	drawStaticPath(pathData) {
		const { tokenId, waypoints, destination, color } = pathData;
		const graphics = new PIXI.Graphics();

		// Draw the black outline
		graphics.lineStyle(6, 0x000000, 0.5);
		this._drawPath(graphics, waypoints, destination);

		// Draw the colored line on top
		graphics.lineStyle(4, color, 0.7);
		this._drawPath(graphics, waypoints, destination);

		canvas.controls.addChild(graphics);
		this._staticPaths = this._staticPaths || {};
		this._staticPaths[tokenId] = graphics;
	},

	_drawPath(graphics, waypoints, destination) {
		graphics.moveTo(waypoints[0].x, waypoints[0].y);
		for (let i = 1; i < waypoints.length; i++) {
			graphics.lineTo(waypoints[i].x, waypoints[i].y);
		}
		graphics.lineTo(destination.x, destination.y);
	},

	clearStaticPath(tokenId) {
		if (this._staticPaths?.[tokenId]) {
			canvas.controls.removeChild(this._staticPaths[tokenId]);
			this._staticPaths[tokenId].destroy();
			delete this._staticPaths[tokenId];
		}
	},

	handleLockMovementToggle() {
		this.setEnabled(!this.getEnabled());
		if (!this.getEnabled()) {
			// Clear all pending requests when disabling
			this._pendingRequests = {};
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

	showPendingRequestIcon() {
		const controls = ui.controls.controls.find((c) => c.name === "token");
		if (controls) {
			const existingTool = controls.tools.find(
				(t) => t.name === PENDING_REQUEST_TOOL_NAME,
			);
			if (!existingTool) {
				controls.tools.push({
					name: PENDING_REQUEST_TOOL_NAME,
					title: game.i18n.localize(
						`${LANGUAGE_PREFIX}.controls.pendingRequest.name`,
					),
					icon: `fas ${PENDING_REQUEST_ICON}`,
					button: true,
					visible: true,
					onClick: () => this.showCancelRequestDialog(),
				});
				ui.controls.render();
			}
		}
	},

	hidePendingRequestIcon() {
		const controls = ui.controls.controls.find((c) => c.name === "token");
		if (controls) {
			const index = controls.tools.findIndex(
				(t) => t.name === PENDING_REQUEST_TOOL_NAME,
			);
			if (index !== -1) {
				controls.tools.splice(index, 1);
				ui.controls.render();
			}
		}
	},

	showCancelRequestDialog() {
		new Dialog({
			title: game.i18n.localize(`${LANGUAGE_PREFIX}.cancelDialog.title`),
			content: game.i18n.localize(`${LANGUAGE_PREFIX}.cancelDialog.content`),
			buttons: {
				cancel: {
					icon: '<i class="fas fa-times"></i>',
					label: game.i18n.localize(`${LANGUAGE_PREFIX}.cancelDialog.cancel`),
					callback: () => this.cancelMovementRequest(),
				},
				close: {
					icon: '<i class="fas fa-check"></i>',
					label: game.i18n.localize(`${LANGUAGE_PREFIX}.cancelDialog.close`),
				},
			},
		}).render(true);
	},

	cancelMovementRequest() {
		const tokenId = Object.keys(this._pendingRequests).find(
			(key) => this._pendingRequests[key].userId === game.user.id,
		);

		if (tokenId) {
			const request = this._pendingRequests[tokenId];
			if (request) {
				const sceneId = request.sceneId;
				const scene = game.scenes.get(sceneId);
				const token = scene.tokens.get(tokenId);
				this.clearStaticPath(tokenId);
				this.removePendingRequest(tokenId);
				game.socket.emit(`module.${this.ID}`, {
					type: "cancelMovementRequest",
					payload: { tokenId, sceneId, tokenName: token.name },
				});
				this.hidePendingRequestIcon();
				ui.notifications.info(
					game.i18n.localize(
						`${LANGUAGE_PREFIX}.notifications.requestCancelled`,
					),
				);
			} else {
				console.warn(
					`Movement Approval: Attempted to cancel non-existent request for token ${tokenId}`,
				);
				this.hidePendingRequestIcon();
			}
		} else {
			console.warn(
				"Movement Approval: No pending request found for current user",
			);
			this.hidePendingRequestIcon();
		}
	},

	handleCancelMovementRequest(data) {
		console.log("should cancel movement request", data);
		this.clearStaticPath(data.tokenId);
		this.removePendingRequest(data.tokenId);

		// Find and close the specific dialog
		const dialogToClose = Object.values(ui.windows).find(
			(w) =>
				w instanceof Dialog &&
				w.data.type === `${MODULE_ID}-dialog` &&
				w.data.tokenId === data.tokenId,
		);

		this.clearStaticPath(data.tokenId);
		this.removePendingRequest(data.tokenId);
		game.socket.emit(`module.${MovementApproval.ID}`, {
			type: "movementDenied",
			payload: data,
		});

		// Clear the ruler for all users
		for (const ruler of canvas.controls.rulers.children) {
			ruler.clear();
		}
		console.log("found", dialogToClose);
		if (dialogToClose) {
			dialogToClose.close();
		}

		ui.notifications.info(
			game.i18n.format(
				`${LANGUAGE_PREFIX}.notifications.requestCancelledByUser`,
				{ tokenName: data.tokenName },
			),
		);
	},

	handleUpdatePendingRequests(updates) {
		for (const [tokenId, request] of Object.entries(updates)) {
			if (request === null) {
				delete this._pendingRequests[tokenId];
			} else {
				this._pendingRequests[tokenId] = request;
			}
		}
		// Update UI if necessary
		this.updatePendingRequestIcon();
	},

	updatePendingRequestIcon() {
		const hasPendingRequest = Object.values(this._pendingRequests).some(
			(request) => request.userId === game.user.id,
		);
		if (hasPendingRequest) {
			this.showPendingRequestIcon();
		} else {
			this.hidePendingRequestIcon();
		}
	},
};

Hooks.once("init", () => {
	MovementApproval.initialize();
});

Hooks.once("setup", () => {
	MovementApproval.registerSettings();
});

Hooks.on("getSceneControlButtons", (controls) => {
	controls
		.find((c) => c.name === "token")
		.tools.push({
			name: "lockMovement",
			title: game.i18n.localize(
				`${LANGUAGE_PREFIX}.controls.lockMovement.name`,
			),
			icon: `fas ${MovementApproval.getEnabled() ? ICON_STATES.ENABLED : ICON_STATES.DISABLED}`,
			button: true,
			visible: game.user.isGM,
			onClick: () => MovementApproval.handleLockMovementToggle(),
		});
});
