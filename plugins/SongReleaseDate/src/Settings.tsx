import React from "react";
import { ReactiveStore } from "@luna/core";
import { LunaSettings, LunaTextSetting, LunaSelectSetting, LunaSelectItem } from "@luna/ui";

export const storage = await ReactiveStore.getPluginStorage("SongReleaseDate", {
    dateFormat: "DD-MM-YYYY",
    position: "after-title" as "after-title" | "below-title" | "below-artist",
});

export const Settings = () => {
    const [dateFormat, setDateFormat] = React.useState<string>(storage.dateFormat);
    const [position, setPosition] = React.useState<string>(storage.position);

    return (
        <LunaSettings>
            <LunaTextSetting
                title="Date Format"
                desc="Tokens: YYYY, MM, DD, M, D — e.g. DD/MM/YYYY, YYYY-MM-DD, MM-YYYY"
                value={dateFormat}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                    setDateFormat((storage.dateFormat = e.target.value));
                }}
            />
            <LunaSelectSetting
                title="Position"
                desc="Where to show the release date"
                value={position}
                onChange={(e: React.ChangeEvent<{ value: unknown }>) => setPosition((storage.position = e.target.value as typeof storage.position))}
            >
                <LunaSelectItem value="after-title">After title</LunaSelectItem>
                <LunaSelectItem value="below-artist">Below artist</LunaSelectItem>
                <LunaSelectItem value="below-title">Below title</LunaSelectItem>
            </LunaSelectSetting>
        </LunaSettings>
    );
};