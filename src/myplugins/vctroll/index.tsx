/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import baseDecoder from "@equicordplugins/baseDecoder";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { Channel, User, VoiceState } from "@vencord/discord-types";
import {
    ChannelActions,
    ChannelStore,
    closeModal,
    GuildActions,
    MediaEngineStore,
    Modal,
    openModal,
    PermissionsBits,
    PermissionStore,
    RestAPI,
    SelectedChannelStore,
    Toasts,
    UserStore,
    useState,
    VoiceActions,
    VoiceStateStore,
} from "@webpack/common";
import { Menu } from "@webpack/common/menu";

import { TimedoutReconnect } from "./Notifcations";

interface UserContextProps {
    channel: Channel;
    user: User;
    guildId?: string;
}

enum TrollAction {
    "Mute" = 0,
    "Deafen" = 1,
    "Disconnect" = 2,
}

interface MemberTroll {
    Member: User;
    Troll: Set<TrollAction>;
}
interface ProtectMember {
    User: User;
    guildId: string;
    Value: boolean;
}

const settings = definePluginSettings({
    AutoReconnect: {
        type: OptionType.BOOLEAN,
        description:
            "Let's you auto reconnect when someone disconnects you from a voice channel, can be turned off temporarily when redisconnecting under 5 seconds\n plugin is a bit messy in the code",
        default: false,
    },
});

let lastdisconnectMS: undefined | number = undefined;

const logger = new Logger("vc-troll");

const members = new Map<string, MemberTroll>();
const ProtectMembers = new Map<string, ProtectMember>();

const previousStates = new Map<string, { mute: boolean; deaf: boolean }>();

function getchannelbyuserid(userId: string) {
    const voiceState = VoiceStateStore.getVoiceStateForUser(userId);
    if (!voiceState || !voiceState.channelId) return;
    const channel = ChannelStore.getChannel(voiceState.channelId);

    const canMute = PermissionStore.can(PermissionsBits.MUTE_MEMBERS, channel);

    if (channel && canMute) {
        return channel;
    }
}

function servermute(value: boolean, gId: string, UID: string) {
    GuildActions.setServerMute(gId, UID, value);
}

function serverdeafen(value: boolean, gId: string, UID: string) {
    GuildActions.setServerDeaf(gId, UID, value);
}

function disconnect(guildId: string, userId: string) {
    RestAPI.patch({
        url: `/guilds/${guildId}/members/${userId}`,
        body: { channel_id: null },
    });
}

function SelfFakeDeafen() {
    VoiceActions.toggleSelfDeaf();

    const isDeafened = MediaEngineStore.isSelfDeaf();

    const originalSend = WebSocket.prototype.send;
    if (isDeafened) {
        WebSocket.prototype.send = function (data) {
            if (data instanceof ArrayBuffer) {
                const text = baseDecoder.decode(data);
                if (text.includes("self_deaf")) {
                    // Decode → modify → re-encode
                    const modified = text.replace(
                        '"self_mute":false',
                        '"self_mute":true',
                    );
                    data = baseDecoder.encode(modified).buffer;
                }
            }
            originalSend.apply(this, [data]);
        };
        VoiceActions.toggleSelfDeaf();
    }
    WebSocket.prototype.send = originalSend;
}

function getServerMuteDeafenState(userId: string) {
    const voiceState = VoiceStateStore.getVoiceStateForUser(userId);
    if (!voiceState) return { isServerMuted: false, isServerDeafened: false };

    return {
        isServerMuted: voiceState.mute ?? false,
        isServerDeafened: voiceState.deaf ?? false,
    };
}

function isMyChannel(channelId?: string): boolean {
    return (
        !!channelId && SelectedChannelStore.getVoiceChannelId() === channelId
    );
}

const UserContextMenuPatch: NavContextMenuPatchCallback = (
    children,
    { user, guildId }: UserContextProps,
) => {
    if (!user) return;

    const member = members.get(user.id);

    const [SMute, setSMute] = useState<boolean>(
        member?.Troll.has(TrollAction.Mute) || false,
    );
    const [SDeafen, setSDeafen] = useState<boolean>(
        member?.Troll.has(TrollAction.Deafen) || false,
    );
    const [Disconnect, setDisconnect] = useState<boolean>(
        member?.Troll.has(TrollAction.Disconnect) || false,
    );

    const protectm = ProtectMembers.get(user.id);

    const [Protect, setprotect] = useState<boolean>(protectm?.Value || false);

    if (guildId !== undefined) {
        children.push(
            <>
                <Menu.MenuSeparator />
                <Menu.MenuCheckboxItem
                    id="vt-protect"
                    label="Protect User"
                    checked={Protect}
                    action={() => {
                        const getprotect = ProtectMembers.get(user.id);

                        if (!getprotect) {
                            setprotect(true);
                            ProtectMembers.set(user.id, {
                                User: user,
                                guildId: guildId,
                                Value: true,
                            });

                            const { isServerDeafened, isServerMuted } =
                                getServerMuteDeafenState(user.id);

                            if (isServerDeafened) {
                                serverdeafen(false, guildId, user.id);
                            } else if (isServerMuted) {
                                servermute(false, guildId, user.id);
                            }
                        } else {
                            setprotect(false);
                            ProtectMembers.delete(user.id);
                        }
                    }}
                />
                <Menu.MenuItem id="adam-category" label="Trolls">
                    {UserStore.getCurrentUser().id === user.id ? (
                        <>
                            <Menu.MenuItem
                                id="test-fakemute"
                                label="fakedeafen"
                                action={() => {
                                    SelfFakeDeafen();
                                }}
                            />
                            <Menu.MenuSeparator />
                        </>
                    ) : null}
                    <Menu.MenuCheckboxItem
                        id="adam-server-mute"
                        label="Server Mute"
                        checked={SMute}
                        action={() => {
                            const checkmember = members.get(user.id);

                            if (checkmember) {
                                logger.log("editing a member!");

                                if (!checkmember.Troll.has(TrollAction.Mute)) {
                                    checkmember.Troll.add(TrollAction.Mute);

                                    setSMute(true);
                                }

                                if (checkmember.Troll.has(TrollAction.Mute)) {
                                    if (checkmember.Troll.size <= 1) {
                                        members.delete(user.id);

                                        logger.log("deleted member");
                                    } else {
                                        checkmember.Troll.delete(
                                            TrollAction.Mute,
                                        );
                                    }

                                    setSMute(false);
                                }
                            } else {
                                logger.log("created new member!");
                                members.set(user.id, {
                                    Member: user,
                                    Troll: new Set([TrollAction.Mute]),
                                });
                                setSMute(true);
                            }

                            const newaction_channel = getchannelbyuserid(
                                user.id,
                            );

                            if (newaction_channel) {
                                if (
                                    members
                                        .get(user.id)
                                        ?.Troll.has(TrollAction.Mute)
                                ) {
                                    servermute(
                                        true,
                                        guildId as string,
                                        user.id,
                                    );
                                } else {
                                    servermute(
                                        false,
                                        guildId as string,
                                        user.id,
                                    );
                                }
                            }
                        }}
                    />
                    <Menu.MenuCheckboxItem
                        id="adam-server-deafen"
                        label="Server Deafen"
                        checked={SDeafen}
                        action={() => {
                            const checkmember = members.get(user.id);

                            if (checkmember) {
                                if (checkmember.Troll.has(TrollAction.Deafen)) {
                                    if (checkmember.Troll.size <= 1) {
                                        members.delete(user.id);
                                    } else {
                                        checkmember.Troll.delete(
                                            TrollAction.Deafen,
                                        );
                                    }

                                    setSDeafen(false);
                                }

                                if (
                                    SDeafen === false &&
                                    !checkmember.Troll.has(TrollAction.Deafen)
                                ) {
                                    checkmember.Troll.add(TrollAction.Deafen);

                                    setSDeafen(true);
                                }
                            } else {
                                members.set(user.id, {
                                    Member: user,
                                    Troll: new Set([TrollAction.Deafen]),
                                });

                                setSDeafen(true);
                            }

                            // Your toggle logic here

                            const newaction_channel = getchannelbyuserid(
                                user.id,
                            );

                            if (newaction_channel) {
                                if (
                                    members
                                        .get(user.id)
                                        ?.Troll.has(TrollAction.Deafen)
                                ) {
                                    serverdeafen(
                                        true,
                                        guildId as string,
                                        user.id,
                                    );
                                } else
                                    serverdeafen(
                                        false,
                                        guildId as string,
                                        user.id,
                                    );

                                return;
                            }
                        }}
                    />
                    <Menu.MenuCheckboxItem
                        id="adam-disconnect"
                        label="Disconnect"
                        checked={Disconnect}
                        action={() => {
                            let checkmember = members.get(user.id);

                            if (checkmember) {
                                if (
                                    checkmember.Troll.has(
                                        TrollAction.Disconnect,
                                    )
                                ) {
                                    if (checkmember.Troll.size <= 1) {
                                        members.delete(user.id);
                                    } else {
                                        checkmember.Troll.delete(
                                            TrollAction.Disconnect,
                                        );
                                    }
                                }

                                if (
                                    Disconnect === false &&
                                    !checkmember.Troll.has(
                                        TrollAction.Disconnect,
                                    )
                                ) {
                                    checkmember.Troll.add(
                                        TrollAction.Disconnect,
                                    );

                                    setDisconnect(true);
                                } else setDisconnect(false);
                            } else {
                                if (Disconnect === true) {
                                    setDisconnect(false);
                                    return;
                                }

                                members.set(user.id, {
                                    Member: user,
                                    Troll: new Set([TrollAction.Disconnect]),
                                });

                                setDisconnect(true);
                            }

                            // Your toggle logic here

                            checkmember = members.get(user.id);

                            const voiceState =
                                VoiceStateStore.getVoiceStateForUser(user.id);
                            if (!voiceState) return;
                            const channel = voiceState?.channelId
                                ? ChannelStore.getChannel(voiceState.channelId)
                                : null;
                            logger.log(channel, checkmember);

                            if (channel) {
                                const canMute = PermissionStore.can(
                                    PermissionsBits.MOVE_MEMBERS,
                                    channel,
                                );

                                if (!canMute) {
                                    members.delete(user.id);

                                    return;
                                }

                                if (
                                    members
                                        .get(user.id)
                                        ?.Troll.has(TrollAction.Disconnect)
                                ) {
                                    // mute function i think

                                    disconnect(guildId as string, user.id);
                                }
                            }
                        }}
                    />
                </Menu.MenuItem>
            </>,
        );
    }
};

const ClientPreviousVoiceState = new Map<
    string | number,
    { ChannelId: string; GuildId: string; When: number }
>();

let Reconnect = false;

function TimeoutReconnectProtection(MS: number) {
    Reconnect = false;
    setTimeout(() => {
        Reconnect = true;
    }, MS);
}

function ShowModal() {
    TimeoutReconnectProtection(6000);

    openModal(
        // eslint-disable-next-line @stylistic/arrow-parens
        (props) => {
            return (
                <Modal
                    title={
                        "Do you want to disable auto Reconnect [Temporarily]"
                    }
                    onClose={() => closeModal("vt-RQ")}
                    transitionState={0}
                    role="alertdialog"
                    input={<h3>why am i seeing this,</h3>}
                    preview={
                        <h4>
                            you left a voice channel and you have auto reconnect
                            on so this is a back up so you don't keep getting
                            dragged to the same voice channel
                        </h4>
                    }
                    actions={[
                        {
                            text: "Yes",
                            variant: "critical-primary",
                            onClick: () => {
                                TimeoutReconnectProtection(1000 * 10);
                                const success = Toasts.create(
                                    "You can now leave without being dragged back!",
                                    "success",
                                    { duration: 4000 },
                                );
                                Toasts.show(success);
                                closeModal("vt-RQ");
                            },
                        },
                        {
                            text: "No",
                            variant: "secondary",
                            onClick: () => closeModal("vt-RQ"),
                        },
                    ]}
                />
            );
        },
        { modalKey: "vt-RQ" },
    );
}

export default definePlugin({
    name: "vc-troll",
    description:
        "trolling friends with server mute/deafen and auto disconnect.",
    authors: [Devs.Sans],
    tags: ["Fun", "Friends"],
    settings,

    flux: {
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: VoiceState[] }) {
            for (const state of voiceStates) {
                const { userId, channelId, oldChannelId, guildId, mute, deaf } =
                    state;
                const prev = previousStates.get(userId);

                if (!guildId) return;

                if (prev && channelId) {
                    const trollmember = members.get(userId);

                    if (trollmember) {
                        for (const action of trollmember.Troll) {
                            // Detect mute removal (unmute)
                            if (mute !== prev.mute) {
                                if (!mute) {
                                    if (action === TrollAction.Mute) {
                                        servermute(true, guildId, userId);
                                    }
                                }
                            }

                            // Detect deafen removal (undeafen)
                            if (deaf !== prev.deaf) {
                                if (!deaf) {
                                    if (action === TrollAction.Deafen) {
                                        serverdeafen(true, guildId, userId);
                                    }
                                }
                            }
                        }
                    }
                }

                // User joined a voice channel
                if (
                    channelId &&
                    !ProtectMembers.get(userId) &&
                    members.get(userId)
                ) {
                    const trollmember = members.get(userId);

                    if (!trollmember) return;

                    for (const action of trollmember.Troll) {
                        switch (action) {
                            case TrollAction.Mute:
                                if (!mute) servermute(true, guildId, userId);
                                break;
                            case TrollAction.Deafen:
                                if (!deaf) serverdeafen(true, guildId, userId);
                                break;
                            case TrollAction.Disconnect:
                                if (channelId !== null)
                                    disconnect(guildId, userId);
                                break;
                            default:
                                break;
                        }
                    }
                } else if (
                    channelId &&
                    !members.get(userId) &&
                    ProtectMembers.get(userId)
                ) {
                    const member = ProtectMembers.get(userId);

                    if (!member) return;

                    if (member.Value === true) {
                        if (mute) {
                            servermute(false, guildId, userId);
                        } else if (deaf) {
                            serverdeafen(false, guildId, userId);
                        }
                    }
                } else if (UserStore.getCurrentUser().id === userId) {
                    if (settings.store.AutoReconnect === false) return;

                    const previous_channel = ClientPreviousVoiceState.get(
                        ClientPreviousVoiceState.size,
                    );

                    if (channelId) {
                        ClientPreviousVoiceState.set(
                            ClientPreviousVoiceState.size + 1,
                            {
                                ChannelId: channelId,
                                GuildId: guildId,
                                When: Date.now(),
                            },
                        );
                    } else if (oldChannelId) {
                        ClientPreviousVoiceState.set(
                            ClientPreviousVoiceState.size + 1,
                            {
                                ChannelId: oldChannelId,
                                GuildId: guildId,
                                When: Date.now(),
                            },
                        );
                    }

                    logger.log(previous_channel, guildId);
                    const c = Toasts.create(
                        `Canceled - ${settings.plain.AutoReconnect}, ${oldChannelId} / ${channelId}?`,
                        "failure",
                        {
                            duration: 5000,
                        },
                    );

                    // Toasts.show(c);

                    // Check if the user is in another guild and not being dragged by someone
                    if (
                        guildId &&
                        previous_channel &&
                        previous_channel.GuildId !== guildId
                    ) {
                        TimeoutReconnectProtection(5000);

                        Toasts.show(TimedoutReconnect);

                        return;
                    }

                    if (lastdisconnectMS === undefined) {
                        lastdisconnectMS = Date.now();
                    } else if (Date.now() - lastdisconnectMS < 1500) {
                        lastdisconnectMS = Date.now();

                        if (Reconnect === true) {
                            ShowModal();
                        }
                    } else lastdisconnectMS = Date.now();

                    if (
                        Reconnect === true &&
                        (oldChannelId || previous_channel)
                    ) {
                        ChannelActions.selectVoiceChannel(oldChannelId);
                    }
                    // Client Previous state
                }

                // Update previous state
                previousStates.set(userId, {
                    mute: state.mute,
                    deaf: state.deaf,
                });
            }
        },
    },
    contextMenus: {
        "user-context": UserContextMenuPatch,
    },
});
